const express = require('express');
const { makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage untuk upload file
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// Store untuk menyimpan koneksi WhatsApp
const sessions = new Map();

// File untuk menyimpan session info
const SESSIONS_FILE = './sessions.json';

// Fungsi untuk load sessions dari file
function loadSessionsFromFile() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
            const sessionData = JSON.parse(data);
            console.log(`Found ${sessionData.length} existing sessions`);
            return sessionData;
        }
    } catch (error) {
        console.error('Error loading sessions file:', error);
    }
    return [];
}

// Fungsi untuk save sessions ke file
function saveSessionsToFile() {
    try {
        const sessionData = Array.from(sessions.keys());
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionData, null, 2));
        console.log(`Saved ${sessionData.length} sessions to file`);
    } catch (error) {
        console.error('Error saving sessions file:', error);
    }
}

// Fungsi untuk scan folder auth dan restore sessions
async function restoreExistingSessions() {
    const authDir = './auth';
    
    if (!fs.existsSync(authDir)) {
        console.log('No auth directory found');
        return;
    }

    try {
        const folders = fs.readdirSync(authDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        console.log(`Found ${folders.length} auth folders:`, folders);

        for (const sessionId of folders) {
            const authPath = path.join(authDir, sessionId);
            
            // Check if auth folder has required files
            const hasAuthFiles = fs.existsSync(path.join(authPath, 'creds.json'));
            
            if (hasAuthFiles && !sessions.has(sessionId)) {
                console.log(`Restoring session: ${sessionId}`);
                
                try {
                    const whatsappService = new WhatsAppService(sessionId);
                    await whatsappService.initialize();
                    sessions.set(sessionId, whatsappService);
                    console.log(`✅ Session ${sessionId} restored successfully`);
                } catch (error) {
                    console.error(`❌ Failed to restore session ${sessionId}:`, error.message);
                    
                    // If auth files are corrupted, clean them up
                    if (error.message.includes('Decryption') || error.message.includes('Invalid')) {
                        console.log(`Cleaning corrupted auth files for ${sessionId}`);
                        fs.rmSync(authPath, { recursive: true, force: true });
                    }
                }
            }
        }
        
        saveSessionsToFile();
        
    } catch (error) {
        console.error('Error restoring sessions:', error);
    }
}

class WhatsAppService {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.sock = null;
        this.qr = null;
        this.isConnected = false;
        this.connectionStatus = 'disconnected'; // disconnected, connecting, connected, qr_needed
        this.retryCount = 0;
        this.maxRetries = 3;
    }

    async initialize() {
        try {
            const authDir = `./auth/${this.sessionId}`;
            
            // Pastikan direktori auth ada
            if (!fs.existsSync('./auth')) {
                fs.mkdirSync('./auth', { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(authDir);

            this.sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: 'silent' }),
                browser: ['WhatsApp-API', 'Safari', '1.0.0'],
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                markOnlineOnConnect: true,
                syncFullHistory: false,
                generateHighQualityLinkPreview: false
            });

            // Event handlers
            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr, isNewLogin, isOnline } = update;

                console.log(`[${this.sessionId}] Connection update:`, {
                    connection,
                    isNewLogin,
                    isOnline,
                    hasQr: !!qr,
                    lastDisconnect: lastDisconnect?.error?.output?.statusCode
                });

                if (qr) {
                    this.qr = qr;
                    this.connectionStatus = 'qr_needed';
                    this.isConnected = false;
                    console.log(`[${this.sessionId}] QR Code generated - Please scan within 20 seconds`);
                    
                    // Clear QR after 20 seconds (WhatsApp QR timeout)
                    setTimeout(() => {
                        if (this.connectionStatus === 'qr_needed') {
                            this.qr = null;
                            console.log(`[${this.sessionId}] QR Code expired`);
                        }
                    }, 20000);
                }

                if (connection === 'close') {
                    this.isConnected = false;
                    this.connectionStatus = 'disconnected';
                    
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const errorMessage = lastDisconnect?.error?.message || 'Unknown error';
                    
                    console.log(`[${this.sessionId}] Connection closed:`, {
                        statusCode,
                        errorMessage,
                        retryCount: this.retryCount
                    });

                    let shouldReconnect = false;
                    let shouldDeleteSession = false;

                    switch (statusCode) {
                        case DisconnectReason.badSession:
                            console.log(`[${this.sessionId}] Bad session, deleting auth files`);
                            shouldDeleteSession = true;
                            break;
                        case DisconnectReason.connectionClosed:
                        case DisconnectReason.connectionLost:
                        case DisconnectReason.restartRequired:
                            shouldReconnect = this.retryCount < this.maxRetries;
                            break;
                        case DisconnectReason.loggedOut:
                            console.log(`[${this.sessionId}] Logged out from WhatsApp`);
                            shouldDeleteSession = true;
                            break;
                        case DisconnectReason.timedOut:
                            shouldReconnect = this.retryCount < this.maxRetries;
                            break;
                        default:
                            shouldReconnect = this.retryCount < this.maxRetries;
                    }

                    if (shouldDeleteSession) {
                        await this.cleanup();
                        sessions.delete(this.sessionId);
                        saveSessionsToFile();
                    } else if (shouldReconnect) {
                        this.retryCount++;
                        console.log(`[${this.sessionId}] Reconnecting... (${this.retryCount}/${this.maxRetries})`);
                        setTimeout(() => this.initialize(), 5000);
                    } else {
                        console.log(`[${this.sessionId}] Max retries reached, removing session`);
                        sessions.delete(this.sessionId);
                        saveSessionsToFile();
                    }

                } else if (connection === 'connecting') {
                    this.connectionStatus = 'connecting';
                    console.log(`[${this.sessionId}] Connecting to WhatsApp...`);
                    
                } else if (connection === 'open') {
                    this.isConnected = true;
                    this.connectionStatus = 'connected';
                    this.qr = null;
                    this.retryCount = 0;
                    console.log(`[${this.sessionId}] ✅ WhatsApp connection established successfully!`);
                    
                    // Save session info
                    saveSessionsToFile();
                    
                    // Verify connection by getting user info
                    try {
                        const userInfo = this.sock.user;
                        console.log(`[${this.sessionId}] Logged in as: ${userInfo?.name || userInfo?.id || 'Unknown'}`);
                    } catch (error) {
                        console.log(`[${this.sessionId}] Could not get user info:`, error.message);
                    }
                }
            });

            this.sock.ev.on('creds.update', saveCreds);

            // Handle messages (optional - for debugging)
            this.sock.ev.on('messages.upsert', (m) => {
                // console.log(`[${this.sessionId}] Received message:`, JSON.stringify(m, undefined, 2));
            });

            return this.sock;
        } catch (error) {
            console.error(`[${this.sessionId}] Error initializing WhatsApp:`, error);
            this.connectionStatus = 'disconnected';
            throw error;
        }
    }

    async cleanup() {
        try {
            const authDir = `./auth/${this.sessionId}`;
            if (fs.existsSync(authDir)) {
                fs.rmSync(authDir, { recursive: true, force: true });
                console.log(`[${this.sessionId}] Auth directory cleaned up`);
            }
        } catch (error) {
            console.error(`[${this.sessionId}] Error cleaning up:`, error);
        }
    }

    async sendMessage(to, message) {
        if (!this.isConnected || this.connectionStatus !== 'connected') {
            throw new Error(`WhatsApp not connected. Status: ${this.connectionStatus}`);
        }

        const formattedNumber = this.formatPhoneNumber(to);
        
        // Verify number exists on WhatsApp (optional check)
        try {
            const [exists] = await this.sock.onWhatsApp(formattedNumber);
            if (!exists) {
                throw new Error('Phone number is not registered on WhatsApp');
            }
        } catch (checkError) {
            console.log(`[${this.sessionId}] Could not verify number existence:`, checkError.message);
            // Continue anyway, sometimes the check fails even for valid numbers
        }

        const result = await this.sock.sendMessage(formattedNumber, { text: message });
        console.log(`[${this.sessionId}] Message sent to ${to}`);
        return result;
    }

    async sendMediaMessage(to, mediaPath, caption = '') {
        if (!this.isConnected || this.connectionStatus !== 'connected') {
            throw new Error(`WhatsApp not connected. Status: ${this.connectionStatus}`);
        }

        const formattedNumber = this.formatPhoneNumber(to);
        const mediaType = this.getMediaType(mediaPath);
        
        const messageContent = {
            [mediaType]: { url: mediaPath },
            caption: caption
        };

        const result = await this.sock.sendMessage(formattedNumber, messageContent);
        console.log(`[${this.sessionId}] Media sent to ${to} (${mediaType})`);
        return result;
    }

    formatPhoneNumber(phoneNumber) {
        // Hapus karakter non-digit
        let formatted = phoneNumber.replace(/\D/g, '');
        
        // Tambahkan kode negara jika belum ada
        if (!formatted.startsWith('62')) {
            if (formatted.startsWith('0')) {
                formatted = '62' + formatted.slice(1);
            } else {
                formatted = '62' + formatted;
            }
        }
        
        return formatted + '@s.whatsapp.net';
    }

    getMediaType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const videoExts = ['.mp4', '.avi', '.mov', '.mkv'];
        const audioExts = ['.mp3', '.wav', '.ogg', '.m4a'];

        if (imageExts.includes(ext)) return 'image';
        if (videoExts.includes(ext)) return 'video';
        if (audioExts.includes(ext)) return 'audio';
        return 'document';
    }

    getQR() {
        return this.qr;
    }

    isReady() {
        return this.isConnected && this.connectionStatus === 'connected';
    }

    getStatus() {
        return {
            isConnected: this.isConnected,
            connectionStatus: this.connectionStatus,
            hasQR: !!this.qr,
            retryCount: this.retryCount,
            user: this.sock?.user || null
        };
    }
}

// Routes

// 0. List semua sessions
app.get('/api/sessions', (req, res) => {
    const sessionList = Array.from(sessions.entries()).map(([sessionId, session]) => ({
        sessionId,
        ...session.getStatus()
    }));

    res.json({
        success: true,
        sessions: sessionList,
        total: sessionList.length
    });
});

// 1. Inisialisasi session baru
app.post('/api/sessions', async (req, res) => {
    try {
        const { sessionId } = req.body;

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                message: 'Session ID is required'
            });
        }

        if (sessions.has(sessionId)) {
            return res.status(409).json({
                success: false,
                message: 'Session already exists'
            });
        }

        const whatsappService = new WhatsAppService(sessionId);
        await whatsappService.initialize();
        
        sessions.set(sessionId, whatsappService);
        saveSessionsToFile();

        res.json({
            success: true,
            message: 'Session initialized successfully',
            sessionId: sessionId
        });

    } catch (error) {
        console.error('Error creating session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to initialize session',
            error: error.message
        });
    }
});

// 2. Get QR Code untuk login
app.get('/api/sessions/:sessionId/qr', (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = sessions.get(sessionId);

        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found. Please create session first or restart server to restore existing sessions.'
            });
        }

        const qr = session.getQR();
        
        if (!qr) {
            return res.status(404).json({
                success: false,
                message: 'QR code not available. Session might be already connected.'
            });
        }

        res.json({
            success: true,
            qr: qr
        });

    } catch (error) {
        console.error('Error getting QR:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get QR code',
            error: error.message
        });
    }
});

// 3. Check status session
app.get('/api/sessions/:sessionId/status', (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = sessions.get(sessionId);

        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found. Please create session first or restart server to restore existing sessions.'
            });
        }

        const status = session.getStatus();
        res.json({
            success: true,
            sessionId: sessionId,
            ...status
        });

    } catch (error) {
        console.error('Error checking status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check session status',
            error: error.message
        });
    }
});

// 4. Kirim pesan teks
app.post('/api/sessions/:sessionId/send-message', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { to, message } = req.body;

        if (!to || !message) {
            return res.status(400).json({
                success: false,
                message: 'Phone number and message are required'
            });
        }

        const session = sessions.get(sessionId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found. Please create session first or restart server to restore existing sessions.'
            });
        }

        if (!session.isReady()) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp session is not connected'
            });
        }

        const result = await session.sendMessage(to, message);

        res.json({
            success: true,
            message: 'Message sent successfully',
            messageId: result.key.id,
            to: to
        });

    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send message',
            error: error.message
        });
    }
});

// 5. Kirim pesan dengan attachment
app.post('/api/sessions/:sessionId/send-media', upload.single('media'), async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { to, caption } = req.body;
        const mediaFile = req.file;

        if (!to || !mediaFile) {
            return res.status(400).json({
                success: false,
                message: 'Phone number and media file are required'
            });
        }

        const session = sessions.get(sessionId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found. Please create session first or restart server to restore existing sessions.'
            });
        }

        if (!session.isReady()) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp session is not connected'
            });
        }

        const result = await session.sendMediaMessage(to, mediaFile.path, caption || '');

        // Hapus file setelah dikirim (opsional)
        setTimeout(() => {
            fs.unlink(mediaFile.path, (err) => {
                if (err) console.error('Error deleting file:', err);
            });
        }, 5000);

        res.json({
            success: true,
            message: 'Media sent successfully',
            messageId: result.key.id,
            to: to,
            mediaType: session.getMediaType(mediaFile.path)
        });

    } catch (error) {
        console.error('Error sending media:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send media',
            error: error.message
        });
    }
});

// 6. Hapus session
app.delete('/api/sessions/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = sessions.get(sessionId);

        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }

        // Logout dan hapus session
        if (session.sock && session.isReady()) {
            try {
                await session.sock.logout();
                console.log(`[${sessionId}] Logged out successfully`);
            } catch (logoutError) {
                console.log(`[${sessionId}] Logout error:`, logoutError.message);
            }
        }

        // Cleanup auth files
        await session.cleanup();
        sessions.delete(sessionId);
        saveSessionsToFile();

        res.json({
            success: true,
            message: 'Session deleted successfully'
        });

    } catch (error) {
        console.error('Error deleting session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete session',
            error: error.message
        });
    }
});

// 8. Force reconnect session
app.post('/api/sessions/:sessionId/reconnect', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = sessions.get(sessionId);

        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found. Please create session first or restart server to restore existing sessions.'
            });
        }

        console.log(`[${sessionId}] Force reconnecting...`);
        
        // Reset connection state
        session.isConnected = false;
        session.connectionStatus = 'disconnected';
        session.retryCount = 0;
        session.qr = null;

        // Close existing connection if any
        if (session.sock) {
            try {
                session.sock.end();
            } catch (e) {
                console.log(`[${sessionId}] Error closing socket:`, e.message);
            }
        }

        // Reinitialize
        await session.initialize();

        res.json({
            success: true,
            message: 'Reconnection initiated',
            sessionId: sessionId
        });

    } catch (error) {
        console.error('Error reconnecting session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reconnect session',
            error: error.message
        });
    }
});

// 9. Clean and reset session (hapus auth files dan restart)
app.post('/api/sessions/:sessionId/reset', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = sessions.get(sessionId);

        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found. Please create session first or restart server to restore existing sessions.'
            });
        }

        console.log(`[${sessionId}] Resetting session...`);

        // Close connection
        if (session.sock) {
            try {
                session.sock.end();
            } catch (e) {
                console.log(`[${sessionId}] Error closing socket:`, e.message);
            }
        }

        // Clean auth files
        await session.cleanup();

        // Remove from sessions
        sessions.delete(sessionId);

        // Create new session
        const newSession = new WhatsAppService(sessionId);
        await newSession.initialize();
        sessions.set(sessionId, newSession);
        saveSessionsToFile();

        res.json({
            success: true,
            message: 'Session reset successfully. Please scan new QR code.',
            sessionId: sessionId
        });

    } catch (error) {
        console.error('Error resetting session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reset session',
            error: error.message
        });
    }
});

// Error handler
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: error.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found'
    });
});

// Initialize server
async function startServer() {
    try {
        // Restore existing sessions saat server start
        console.log('🔄 Restoring existing sessions...');
        await restoreExistingSessions();
        
        // Start server
        app.listen(PORT, () => {
            console.log(`🚀 WhatsApp API Server running on port ${PORT}`);
            console.log(`📱 Active sessions: ${sessions.size}`);
            console.log(`
Available endpoints:
- GET    /api/sessions                           - List all sessions
- POST   /api/sessions                           - Create new session
- GET    /api/sessions/:sessionId/qr             - Get QR code
- GET    /api/sessions/:sessionId/status         - Check session status
- POST   /api/sessions/:sessionId/send-message   - Send text message
- POST   /api/sessions/:sessionId/send-media     - Send media message
- POST   /api/sessions/:sessionId/reconnect      - Force reconnect session
- POST   /api/sessions/:sessionId/reset          - Reset session (clean auth)
- DELETE /api/sessions/:sessionId                - Delete session

Troubleshooting:
- If session not found after server restart: Sessions are auto-restored from auth folder
- If login failed on WhatsApp: Use /reset endpoint to clean auth files
- Check /status endpoint for detailed connection info
- Use GET /api/sessions to list all active sessions
            `);
        });
        
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down server...');
    
    // Close all WhatsApp connections
    for (const [sessionId, session] of sessions.entries()) {
        try {
            if (session.sock) {
                session.sock.end();
            }
            console.log(`✅ Closed session: ${sessionId}`);
        } catch (error) {
            console.error(`❌ Error closing session ${sessionId}:`, error.message);
        }
    }
    
    console.log('👋 Server stopped');
    process.exit(0);
});

// Start the server
startServer();

module.exports = app;