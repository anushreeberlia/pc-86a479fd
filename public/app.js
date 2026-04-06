// Global state
let isPolling = false;
let pollingInterval;
let databaseType = 'unknown';

// Initialize the app
document.addEventListener('DOMContentLoaded', function() {
    loadCredentials();
    updateBotStatus();
    loadReservationHistory();
    startPolling();
});

// Polling for real-time updates
function startPolling() {
    if (isPolling) return;
    
    isPolling = true;
    pollingInterval = setInterval(() => {
        updateBotStatus();
    }, 5000); // Update every 5 seconds
}

function stopPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        isPolling = false;
    }
}

// Database status update
function updateDatabaseStatus(type) {
    const statusElement = document.getElementById('databaseStatus');
    databaseType = type;
    
    if (type === 'Supabase') {
        statusElement.textContent = 'Connected to Supabase';
        statusElement.className = 'database-status supabase';
    } else {
        statusElement.textContent = 'In-Memory Storage';
        statusElement.className = 'database-status memory';
    }
}

// Tab functionality
function showTab(tabName) {
    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Remove active class from all tab buttons
    document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.remove('active');
    });
    
    // Show selected tab
    document.getElementById(`${tabName}-tab`).classList.add('active');
    event.target.classList.add('active');
}

// Credentials Management
async function loadCredentials() {
    try {
        const response = await fetch('/api/credentials');
        const data = await response.json();
        
        if (data.hasCredentials) {
            document.getElementById('username').value = data.username;
            document.getElementById('credentialsStatus').innerHTML = 
                '<div class="status success">✅ Credentials saved</div>';
        }
    } catch (error) {
        console.error('Error loading credentials:', error);
        showStatus('credentialsStatus', 'Error loading credentials', 'error');
    }
}

async function saveCredentials() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    
    if (!username || !password) {
        showStatus('credentialsStatus', 'Please fill in both username and password', 'error');
        return;
    }
    
    try {
        const response = await fetch('/api/credentials', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
            showStatus('credentialsStatus', 'Credentials saved successfully! 🎉', 'success');
            document.getElementById('password').value = ''; // Clear password field
            addLogEntry('Credentials updated', 'success');
        } else {
            throw new Error(data.error || 'Failed to save credentials');
        }
    } catch (error) {
        console.error('Error saving credentials:', error);
        showStatus('credentialsStatus', `Error: ${error.message}`, 'error');
    }
}

// Bot Control
async function startBot() {
    try {
        const response = await fetch('/api/bot/start', { method: 'POST' });
        const data = await response.json();
        
        if (response.ok && data.success) {
            updateBotStatus();
            addLogEntry('Bot started successfully', 'success');
        } else {
            throw new Error(data.error || data.message || 'Failed to start bot');
        }
    } catch (error) {
        console.error('Error starting bot:', error);
        addLogEntry(`Error starting bot: ${error.message}`, 'error');
    }
}

async function stopBot() {
    try {
        const response = await fetch('/api/bot/stop', { method: 'POST' });
        const data = await response.json();
        
        if (response.ok && data.success) {
            updateBotStatus();
            addLogEntry('Bot stopped', 'success');
        } else {
            throw new Error(data.error || data.message || 'Failed to stop bot');
        }
    } catch (error) {
        console.error('Error stopping bot:', error);
        addLogEntry(`Error stopping bot: ${error.message}`, 'error');
    }
}

// Manual reservation attempt
async function manualReservation() {
    const button = event.target;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Checking...';
    
    addLogEntry('Manual reservation attempt started...', 'info');
    
    try {
        const response = await fetch('/api/reserve', { method: 'POST' });
        const data = await response.json();
        
        if (response.ok) {
            if (data.success) {
                addLogEntry(`SUCCESS: ${data.message}`, 'success');
            } else {
                addLogEntry(`Result: ${data.message}`, 'info');
            }
        } else {
            throw new Error(data.error || 'Reservation attempt failed');
        }
        
        // Refresh history after manual attempt
        setTimeout(() => {
            loadReservationHistory();
        }, 2000);
        
    } catch (error) {
        console.error('Error with manual reservation:', error);
        addLogEntry(`Error: ${error.message}`, 'error');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

// Status Updates
async function updateBotStatus() {
    try {
        const response = await fetch('/api/status');
        const status = await response.json();
        
        // Update database status
        updateDatabaseStatus(status.database);
        
        // Update status indicator
        const indicator = document.getElementById('statusIndicator');
        const statusText = document.getElementById('statusText');
        const startBtn = document.getElementById('startBtn');
        const stopBtn = document.getElementById('stopBtn');
        
        if (status.isRunning) {
            indicator.className = 'status-indicator running';
            statusText.textContent = 'Bot is running';
            startBtn.disabled = true;
            stopBtn.disabled = false;
        } else {
            indicator.className = 'status-indicator stopped';
            statusText.textContent = 'Bot is stopped';
            startBtn.disabled = false;
            stopBtn.disabled = true;
        }
        
        // Update timestamps
        document.getElementById('lastCheck').textContent = 
            status.lastCheck ? formatTimestamp(status.lastCheck) : 'Never';
        
        document.getElementById('nextCheck').textContent = 
            status.isRunning ? 'Within 5 minutes' : 'Not scheduled';
        
        // Update logs
        updateLiveLogs(status.logs || []);
        
    } catch (error) {
        console.error('Error updating bot status:', error);
        // Don't show error to user for status updates to avoid spam
    }
}

// Live Logs
function updateLiveLogs(logs) {
    const container = document.getElementById('liveLogs');
    
    if (logs.length === 0) {
        container.innerHTML = '<div class="log-entry">No activity yet...</div>';
        return;
    }
    
    container.innerHTML = logs.map(log => {
        const time = formatTimestamp(log.timestamp);
        const className = getLogEntryClass(log.message);
        return `<div class="log-entry ${className}">[${time}] ${escapeHtml(log.message)}</div>`;
    }).join('');
    
    // Auto-scroll to top (newest entries)
    container.scrollTop = 0;
}

function getLogEntryClass(message) {
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('success') || lowerMessage.includes('✅')) {
        return 'success';
    } else if (lowerMessage.includes('error') || lowerMessage.includes('failed')) {
        return 'error';
    }
    return '';
}

function addLogEntry(message, type = 'info') {
    const container = document.getElementById('liveLogs');
    const time = formatTimestamp(new Date().toISOString());
    const className = type === 'success' ? 'success' : type === 'error' ? 'error' : '';
    
    const entry = document.createElement('div');
    entry.className = `log-entry ${className}`;
    entry.textContent = `[${time}] ${message}`;
    
    container.insertBefore(entry, container.firstChild);
    
    // Keep only last 50 entries in DOM
    while (container.children.length > 50) {
        container.removeChild(container.lastChild);
    }
}

function clearLogs() {
    document.getElementById('liveLogs').innerHTML = 
        '<div class="log-entry">Logs cleared...</div>';
}

// Reservation History
async function loadReservationHistory() {
    try {
        const response = await fetch('/api/logs');
        const logs = await response.json();
        
        const container = document.getElementById('reservationHistory');
        
        if (!response.ok) {
            throw new Error(logs.error || 'Failed to load history');
        }
        
        if (!logs || logs.length === 0) {
            container.innerHTML = '<div class="history-item">No reservation attempts yet</div>';
            return;
        }
        
        container.innerHTML = logs.map(log => {
            const className = log.success ? 'success' : 'failed';
            const time = formatTimestamp(log.created_at);
            
            return `
                <div class="history-item ${className}">
                    <div class="history-time">${time}</div>
                    <div class="history-message">${escapeHtml(log.message)}</div>
                    ${log.details ? `<div class="history-details">${escapeHtml(log.details)}</div>` : ''}
                </div>
            `;
        }).join('');
        
    } catch (error) {
        console.error('Error loading reservation history:', error);
        document.getElementById('reservationHistory').innerHTML = 
            `<div class="history-item failed">Error loading history: ${error.message}</div>`;
    }
}

function refreshHistory() {
    loadReservationHistory();
    addLogEntry('Reservation history refreshed', 'info');
}

// Utility Functions
function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showStatus(elementId, message, type) {
    const statusDiv = document.getElementById(elementId);
    statusDiv.innerHTML = `<div class="status ${type}">${escapeHtml(message)}</div>`;
    
    // Auto-clear success messages after 5 seconds
    if (type === 'success') {
        setTimeout(() => {
            statusDiv.innerHTML = '';
        }, 5000);
    }
}

// Error handling for fetch requests
window.addEventListener('unhandledrejection', event => {
    console.error('Unhandled promise rejection:', event.reason);
    addLogEntry(`Unexpected error: ${event.reason}`, 'error');
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    stopPolling();
});