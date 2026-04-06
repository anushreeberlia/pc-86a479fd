const express = require('express');
const path = require('path');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory storage
let storage = {
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

console.log('✅ SF Tennis Bot initialized with in-memory storage');

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'SF Tennis Bot is running', 
    timestamp: new Date().toISOString(),
    storage: 'In-Memory',
    version: '1.0.0'
  });
});

// Get bot status
app.get('/api/status', (req, res) => {
  res.json({
    ...botStatus,
    storage: 'In-Memory'
  });
});

// Get saved credentials
app.get('/api/credentials', (req, res) => {
  try {
    const credentials = storage.credentials;
    
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
app.post('/api/credentials', (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    storage.credentials = {
      id: 1,
      username,
      password,
      updated_at: new Date().toISOString()
    };
    
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
app.get('/api/logs', (req, res) => {
  try {
    const logs = [...storage.reservationLogs]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 100);
    
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
  
  const intervalMinutes = process.env.CHECK_INTERVAL_MINUTES || 5;
  
  // Check every X minutes - configurable via environment
  cronJob = cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
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
  botStatus.nextCheck = `Within ${intervalMinutes} minutes`;
  addLog(`Bot started - checking every ${intervalMinutes} minutes for Alice Marble reservations`);
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
    const credentials = storage.credentials;
    
    if (!credentials) {
      throw new Error('No credentials found. Please save your login details first.');
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
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
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
      logReservationAttempt(result.message, false, `Page title: ${pageContent.title}`);
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
      logReservationAttempt(result.message, false, 'No reservation links detected');
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
            if (usernameField) {
              await page.type(selector, credentials.username);
              break;
            }
          }
          
          if (usernameField) {
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
        
        logReservationAttempt(
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
    
    logReservationAttempt(
      result.message,
      false,
      JSON.stringify(links.map(l => ({ text: l.text, href: l.href })))
    );
    
    return result;
    
  } catch (error) {
    const errorMessage = `Reservation attempt failed: ${error.message}`;
    logReservationAttempt(errorMessage, false, error.stack);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(console.error);
    }
  }
}

function logReservationAttempt(message, success, details = '') {
  const logEntry = {
    id: storage.reservationLogs.length + 1,
    message,
    success,
    details,
    created_at: new Date().toISOString()
  };
  
  try {
    storage.reservationLogs.push(logEntry);
    
    // Keep only last 1000 entries in memory
    if (storage.reservationLogs.length > 1000) {
      storage.reservationLogs = storage.reservationLogs.slice(-1000);
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
  console.log(`📊 Storage: In-Memory`);
  addLog(`Server started on port ${PORT} with in-memory storage`);
});