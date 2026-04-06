const express = require('express');
const path = require('path');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Global state
let botStatus = {
  isRunning: false,
  lastCheck: null,
  nextCheck: null,
  logs: []
};

let cronJob = null;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'SF Tennis Bot is running', timestamp: new Date().toISOString() });
});

// Get bot status
app.get('/api/status', (req, res) => {
  res.json(botStatus);
});

// Get saved credentials
app.get('/api/credentials', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_credentials')
      .select('*')
      .single();
    
    if (error && error.code !== 'PGRST116') {
      throw error;
    }
    
    res.json({ 
      hasCredentials: !!data,
      username: data?.username || '',
      // Don't send password back for security
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save credentials
app.post('/api/credentials', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const { data, error } = await supabase
      .from('user_credentials')
      .upsert({ 
        id: 1, // Single user system
        username,
        password,
        updated_at: new Date().toISOString()
      })
      .select();
    
    if (error) throw error;
    
    addLog('Credentials updated successfully');
    res.json({ success: true });
  } catch (error) {
    addLog(`Error saving credentials: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Start/Stop bot
app.post('/api/bot/:action', (req, res) => {
  const { action } = req.params;
  
  if (action === 'start') {
    startBot();
    res.json({ success: true, message: 'Bot started' });
  } else if (action === 'stop') {
    stopBot();
    res.json({ success: true, message: 'Bot stopped' });
  } else {
    res.status(400).json({ error: 'Invalid action' });
  }
});

// Get reservation logs
app.get('/api/logs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reservation_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    
    if (error) throw error;
    
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual reservation attempt
app.post('/api/reserve', async (req, res) => {
  try {
    addLog('Manual reservation attempt started');
    const result = await attemptReservation();
    res.json({ success: result.success, message: result.message });
  } catch (error) {
    addLog(`Manual reservation error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

function addLog(message) {
  const timestamp = new Date().toISOString();
  botStatus.logs.unshift({ timestamp, message });
  
  // Keep only last 100 logs in memory
  if (botStatus.logs.length > 100) {
    botStatus.logs = botStatus.logs.slice(0, 100);
  }
  
  console.log(`[${timestamp}] ${message}`);
}

function startBot() {
  if (botStatus.isRunning) {
    addLog('Bot is already running');
    return;
  }
  
  // Check every 5 minutes - adjust as needed
  cronJob = cron.schedule('*/5 * * * *', async () => {
    botStatus.lastCheck = new Date().toISOString();
    addLog('Checking for available reservations...');
    
    try {
      const result = await attemptReservation();
      if (result.success) {
        addLog(`SUCCESS: ${result.message}`);
      } else {
        addLog(`Check complete: ${result.message}`);
      }
    } catch (error) {
      addLog(`Error during check: ${error.message}`);
    }
  });
  
  botStatus.isRunning = true;
  addLog('Bot started - checking every 5 minutes for Alice Marble reservations');
}

function stopBot() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
  
  botStatus.isRunning = false;
  botStatus.nextCheck = null;
  addLog('Bot stopped');
}

async function attemptReservation() {
  let browser = null;
  
  try {
    // Get credentials
    const { data: credentials, error } = await supabase
      .from('user_credentials')
      .select('*')
      .single();
    
    if (error || !credentials) {
      throw new Error('No credentials found. Please save your login details first.');
    }
    
    // Launch browser
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    // Navigate to SF Rec & Parks tennis reservation page
    await page.goto('https://sfrecpark.org/1446/Reservable-Tennis-Courts', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Look for Alice Marble courts specifically
    const aliceMarbleFound = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('alice marble');
    });
    
    if (!aliceMarbleFound) {
      return { success: false, message: 'Alice Marble courts not found on page' };
    }
    
    // Try to find and click reservation links for Alice Marble
    const reservationLinks = await page.$$eval('a', links => 
      links.filter(link => 
        link.href && 
        (link.href.includes('reservation') || link.href.includes('book')) &&
        link.textContent.toLowerCase().includes('alice marble')
      ).map(link => link.href)
    );
    
    if (reservationLinks.length === 0) {
      // Look for general reservation system link
      const generalLinks = await page.$$eval('a', links => 
        links.filter(link => 
          link.href && 
          (link.href.includes('reservation') || 
           link.href.includes('book') ||
           link.href.includes('tennis'))
        ).map(link => ({ href: link.href, text: link.textContent }))
      );
      
      await logReservationAttempt('No direct Alice Marble reservation links found', false, `Found ${generalLinks.length} general links`);
      return { success: false, message: `No direct reservation links found. Found ${generalLinks.length} general reservation links.` };
    }
    
    // Navigate to first reservation link
    await page.goto(reservationLinks[0], { waitUntil: 'networkidle2' });
    
    // Attempt login if login form is present
    const loginForm = await page.$('input[type="password"]');
    if (loginForm) {
      await page.type('input[type="email"], input[name="username"], input[name="email"]', credentials.username);
      await page.type('input[type="password"]', credentials.password);
      
      const loginButton = await page.$('button[type="submit"], input[type="submit"], button:contains("Login")');
      if (loginButton) {
        await loginButton.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
      }
    }
    
    // Look for available Alice Marble courts
    const availableCourts = await page.evaluate(() => {
      const courts = [];
      const elements = document.querySelectorAll('*');
      
      elements.forEach(el => {
        const text = el.textContent;
        if (text && text.toLowerCase().includes('alice marble') && 
            (text.toLowerCase().includes('available') || 
             text.toLowerCase().includes('book') ||
             text.toLowerCase().includes('reserve'))) {
          courts.push(text);
        }
      });
      
      return courts;
    });
    
    const result = {
      success: availableCourts.length > 0,
      message: availableCourts.length > 0 
        ? `Found ${availableCourts.length} available Alice Marble courts`
        : 'No available Alice Marble courts found'
    };
    
    await logReservationAttempt(
      result.message,
      result.success,
      JSON.stringify(availableCourts)
    );
    
    return result;
    
  } catch (error) {
    await logReservationAttempt(
      `Reservation attempt failed: ${error.message}`,
      false,
      error.stack
    );
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function logReservationAttempt(message, success, details = '') {
  try {
    await supabase
      .from('reservation_logs')
      .insert({
        message,
        success,
        details,
        created_at: new Date().toISOString()
      });
  } catch (error) {
    console.error('Error logging reservation attempt:', error);
  }
}

// Initialize database tables
async function initializeTables() {
  try {
    // This would typically be done via Supabase dashboard
    // The SQL for these tables is provided in the frontend
    addLog('Server started - database tables should be created via Supabase dashboard');
  } catch (error) {
    addLog(`Database initialization error: ${error.message}`);
  }
}

app.listen(PORT, () => {
  console.log(`SF Tennis Bot running on port ${PORT}`);
  addLog(`Server started on port ${PORT}`);
  initializeTables();
});