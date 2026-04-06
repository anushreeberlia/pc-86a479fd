const express = require('express');
const path = require('path');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Supabase client only if environment variables are provided
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
  console.log('✅ Supabase client initialized');
} else {
  console.log('⚠️  Supabase not configured - using in-memory storage');
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory storage when Supabase is not available
let inMemoryStorage = {
  credentials: null,
  reservationLogs: []
};

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
  res.json({ 
    status: 'SF Tennis Bot is running', 
    timestamp: new Date().toISOString(),
    database: supabase ? 'Supabase' : 'In-Memory',
    version: '1.0.0'
  });
});

// Get bot status
app.get('/api/status', (req, res) => {
  res.json({
    ...botStatus,
    database: supabase ? 'Supabase' : 'In-Memory'
  });
});

// Get saved credentials
app.get('/api/credentials', async (req, res) => {
  try {
    let credentials = null;
    
    if (supabase) {
      const { data, error } = await supabase
        .from('user_credentials')
        .select('*')
        .single();
      
      if (error && error.code !== 'PGRST116') {
        throw error;
      }
      
      credentials = data;
    } else {
      credentials = inMemoryStorage.credentials;
    }
    
    res.json({ 
      hasCredentials: !!credentials,
      username: credentials?.username || '',
      // Don't send password back for security
    });
  } catch (error) {
    addLog(`Error loading credentials: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Save credentials
app.post('/api/credentials', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    const credentialData = {
      id: 1,
      username,
      password,
      updated_at: new Date().toISOString()
    };
    
    if (supabase) {
      const { data, error } = await supabase
        .from('user_credentials')
        .upsert(credentialData)
        .select();
      
      if (error) throw error;
    } else {
      inMemoryStorage.credentials = credentialData;
    }
    
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
    let logs = [];
    
    if (supabase) {
      const { data, error } = await supabase
        .from('reservation_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      
      if (error) throw error;
      logs = data || [];
    } else {
      logs = [...inMemoryStorage.reservationLogs]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 100);
    }
    
    res.json(logs);
  } catch (error) {
    addLog(`Error loading logs: ${error.message}`);
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
  botStatus.nextCheck = 'Within 5 minutes';
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
    let credentials = null;
    
    if (supabase) {
      const { data, error } = await supabase
        .from('user_credentials')
        .select('*')
        .single();
      
      if (error || !data) {
        throw new Error('No credentials found. Please save your login details first.');
      }
      credentials = data;
    } else {
      credentials = inMemoryStorage.credentials;
      if (!credentials) {
        throw new Error('No credentials found. Please save your login details first.');
      }
    }
    
    // Launch browser with better configuration for deployment
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run'
      ]
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Set longer timeout for slow connections
    page.setDefaultTimeout(60000);
    
    // Navigate to SF Rec & Parks tennis reservation page
    addLog('Navigating to SF Rec & Parks website...');
    await page.goto('https://sfrecpark.org/1446/Reservable-Tennis-Courts', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    
    // Look for Alice Marble courts specifically
    const pageContent = await page.evaluate(() => {
      return {
        hasAliceMarble: document.body.innerText.toLowerCase().includes('alice marble'),
        title: document.title,
        bodyText: document.body.innerText.substring(0, 500)
      };
    });
    
    if (!pageContent.hasAliceMarble) {
      const result = {
        success: false,
        message: 'Alice Marble courts not found on the main page'
      };
      await logReservationAttempt(result.message, false, `Page title: ${pageContent.title}`);
      return result;
    }
    
    addLog('Alice Marble courts found on page, looking for reservation links...');
    
    // Look for reservation links
    const links = await page.evaluate(() => {
      const allLinks = Array.from(document.querySelectorAll('a'));
      return allLinks
        .filter(link => {
          const href = link.href || '';
          const text = link.textContent || '';
          return (
            href.includes('reservation') ||
            href.includes('book') ||
            href.includes('tennis') ||
            text.toLowerCase().includes('reserve') ||
            text.toLowerCase().includes('book')
          );
        })
        .map(link => ({
          href: link.href,
          text: link.textContent.trim(),
          hasAliceMarble: link.textContent.toLowerCase().includes('alice marble')
        }));
    });
    
    if (links.length === 0) {
      const result = {
        success: false,
        message: 'No reservation links found on the page'
      };
      await logReservationAttempt(result.message, false, 'No reservation links detected');
      return result;
    }
    
    addLog(`Found ${links.length} potential reservation links`);
    
    // Try to navigate to the first relevant link
    const primaryLink = links.find(link => link.hasAliceMarble) || links[0];
    
    if (primaryLink && primaryLink.href) {
      addLog(`Attempting to access: ${primaryLink.text}`);
      await page.goto(primaryLink.href, { waitUntil: 'networkidle2' });
      
      // Check if we're on a reservation system
      const isReservationPage = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return (
          text.includes('reserve') ||
          text.includes('book') ||
          text.includes('available') ||
          text.includes('schedule')
        );
      });
      
      if (isReservationPage) {
        // Look for login form
        const hasLoginForm = await page.$('input[type="password"]');
        if (hasLoginForm) {
          addLog('Login form detected, attempting to log in...');
          
          // Try different username field selectors
          const usernameSelectors = [
            'input[type="email"]',
            'input[name="username"]',
            'input[name="email"]',
            'input[name="user"]'
          ];
          
          let usernameField = null;
          for (const selector of usernameSelectors) {
            usernameField = await page.$(selector);
            if (usernameField) break;
          }
          
          if (usernameField) {
            await page.type(usernameSelectors.find(sel => page.$(sel)), credentials.username);
            await page.type('input[type="password"]', credentials.password);
            
            const loginButton = await page.$('button[type="submit"], input[type="submit"]') ||
                              await page.$('button:contains("Login")');
            
            if (loginButton) {
              await loginButton.click();
              await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {
                addLog('Login navigation timeout - continuing...');
              });
            }
          }
        }
        
        // Look for Alice Marble court availability
        const courtInfo = await page.evaluate(() => {
          const text = document.body.innerText;
          const courts = [];
          
          // Look for text mentioning Alice Marble
          const lines = text.split('\n');
          lines.forEach(line => {
            if (line.toLowerCase().includes('alice marble')) {
              courts.push(line.trim());
            }
          });
          
          return {
            courts,
            hasAvailable: text.toLowerCase().includes('available'),
            hasBooking: text.toLowerCase().includes('book') || text.toLowerCase().includes('reserve')
          };
        });
        
        const result = {
          success: courtInfo.courts.length > 0 && courtInfo.hasAvailable,
          message: courtInfo.courts.length > 0 
            ? `Found Alice Marble court information: ${courtInfo.courts.join(', ')}`
            : 'No Alice Marble court availability found'
        };
        
        await logReservationAttempt(
          result.message,
          result.success,
          JSON.stringify(courtInfo)
        );
        
        return result;
      }
    }
    
    const result = {
      success: false,
      message: `Found ${links.length} links but unable to access reservation system`
    };
    
    await logReservationAttempt(
      result.message,
      false,
      JSON.stringify(links.map(l => ({ text: l.text, href: l.href })))
    );
    
    return result;
    
  } catch (error) {
    const errorMessage = `Reservation attempt failed: ${error.message}`;
    await logReservationAttempt(errorMessage, false, error.stack);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(console.error);
    }
  }
}

async function logReservationAttempt(message, success, details = '') {
  const logEntry = {
    message,
    success,
    details,
    created_at: new Date().toISOString()
  };
  
  try {
    if (supabase) {
      await supabase
        .from('reservation_logs')
        .insert(logEntry);
    } else {
      // Add ID for in-memory storage
      logEntry.id = inMemoryStorage.reservationLogs.length + 1;
      inMemoryStorage.reservationLogs.push(logEntry);
      
      // Keep only last 1000 entries in memory
      if (inMemoryStorage.reservationLogs.length > 1000) {
        inMemoryStorage.reservationLogs = inMemoryStorage.reservationLogs.slice(-1000);
      }
    }
  } catch (error) {
    console.error('Error logging reservation attempt:', error);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  stopBot();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  stopBot();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🎾 SF Tennis Bot running on port ${PORT}`);
  console.log(`📊 Database: ${supabase ? 'Supabase' : 'In-Memory Storage'}`);
  addLog(`Server started on port ${PORT} with ${supabase ? 'Supabase' : 'in-memory'} storage`);
});