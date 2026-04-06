const express = require('express');
const path = require('path');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Simple in-memory storage
let appData = {
  credentials: null,
  isRunning: false,
  logs: [],
  reservationHistory: []
};

let cronJob = null;

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'SF Tennis Bot is running', 
    timestamp: new Date().toISOString()
  });
});

// Get current status
app.get('/api/status', (req, res) => {
  res.json({
    isRunning: appData.isRunning,
    hasCredentials: !!appData.credentials,
    logsCount: appData.logs.length,
    historyCount: appData.reservationHistory.length
  });
});

// Get logs
app.get('/api/logs', (req, res) => {
  res.json(appData.logs.slice(-50)); // Last 50 logs
});

// Get reservation history
app.get('/api/history', (req, res) => {
  res.json(appData.reservationHistory.slice(-20)); // Last 20 attempts
});

// Save credentials
app.post('/api/credentials', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  appData.credentials = { username, password };
  addLog('Credentials saved successfully');
  res.json({ success: true });
});

// Check if credentials exist
app.get('/api/credentials', (req, res) => {
  res.json({ 
    hasCredentials: !!appData.credentials,
    username: appData.credentials?.username || ''
  });
});

// Start bot
app.post('/api/bot/start', (req, res) => {
  if (appData.isRunning) {
    return res.json({ success: false, message: 'Bot already running' });
  }
  
  if (!appData.credentials) {
    return res.status(400).json({ error: 'No credentials saved' });
  }
  
  startBot();
  res.json({ success: true, message: 'Bot started' });
});

// Stop bot
app.post('/api/bot/stop', (req, res) => {
  stopBot();
  res.json({ success: true, message: 'Bot stopped' });
});

// Manual reservation attempt
app.post('/api/reserve', async (req, res) => {
  if (!appData.credentials) {
    return res.status(400).json({ error: 'No credentials saved' });
  }
  
  try {
    addLog('Manual reservation attempt started');
    const result = await attemptReservation();
    res.json(result);
  } catch (error) {
    const errorMsg = `Manual reservation failed: ${error.message}`;
    addLog(errorMsg);
    res.status(500).json({ error: errorMsg });
  }
});

function addLog(message) {
  const timestamp = new Date().toISOString();
  appData.logs.unshift({
    timestamp,
    message
  });
  
  // Keep only last 100 logs
  if (appData.logs.length > 100) {
    appData.logs = appData.logs.slice(0, 100);
  }
  
  console.log(`[${timestamp}] ${message}`);
}

function startBot() {
  if (appData.isRunning) return;
  
  // Check every 5 minutes
  cronJob = cron.schedule('*/5 * * * *', async () => {
    addLog('Checking for Alice Marble court availability...');
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
  
  appData.isRunning = true;
  addLog('Bot started - monitoring Alice Marble courts every 5 minutes');
}

function stopBot() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
  appData.isRunning = false;
  addLog('Bot stopped');
}

async function attemptReservation() {
  let browser = null;
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    // Navigate to the tennis courts page
    await page.goto('https://sfrecpark.org/1446/Reservable-Tennis-Courts', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Check if Alice Marble is mentioned
    const pageInfo = await page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();
      const hasAliceMarble = bodyText.includes('alice marble');
      
      // Look for reservation links
      const links = Array.from(document.querySelectorAll('a'))
        .filter(link => {
          const href = link.href.toLowerCase();
          const text = link.textContent.toLowerCase();
          return href.includes('reserve') || href.includes('book') || 
                 text.includes('reserve') || text.includes('book');
        })
        .map(link => ({
          href: link.href,
          text: link.textContent.trim()
        }));
      
      return {
        hasAliceMarble,
        reservationLinks: links,
        title: document.title
      };
    });
    
    const result = {
      success: false,
      message: ''
    };
    
    if (!pageInfo.hasAliceMarble) {
      result.message = 'Alice Marble courts not found on page';
    } else if (pageInfo.reservationLinks.length === 0) {
      result.message = 'Alice Marble found but no reservation links detected';
    } else {
      result.message = `Alice Marble page accessed. Found ${pageInfo.reservationLinks.length} reservation links`;
      
      // Try to access the first reservation link
      if (pageInfo.reservationLinks[0]) {
        try {
          await page.goto(pageInfo.reservationLinks[0].href, {
            waitUntil: 'networkidle2',
            timeout: 20000
          });
          
          // Check if we reached a reservation system
          const isReservationSystem = await page.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            return text.includes('available') || text.includes('book') || 
                   text.includes('reserve') || text.includes('schedule');
          });
          
          if (isReservationSystem) {
            result.message += ' - Reached reservation system';
            
            // Look for login form
            const hasLoginForm = await page.$('input[type="password"]');
            if (hasLoginForm) {
              result.message += ' - Login form detected';
              // In a real implementation, you'd login here
            }
          }
        } catch (linkError) {
          result.message += ` - Could not access reservation link: ${linkError.message}`;
        }
      }
    }
    
    // Log the attempt
    appData.reservationHistory.unshift({
      timestamp: new Date().toISOString(),
      success: result.success,
      message: result.message,
      pageTitle: pageInfo.title
    });
    
    // Keep only last 50 history entries
    if (appData.reservationHistory.length > 50) {
      appData.reservationHistory = appData.reservationHistory.slice(0, 50);
    }
    
    return result;
    
  } finally {
    if (browser) {
      await browser.close().catch(console.error);
    }
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully');
  stopBot();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down gracefully');
  stopBot();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🎾 SF Tennis Bot running on port ${PORT}`);
  addLog(`Server started on port ${PORT}`);
});