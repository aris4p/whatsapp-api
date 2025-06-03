# WhatsApp API Documentation

API sederhana untuk mengirim pesan WhatsApp menggunakan Node.js dan Baileys library.

## Base URL
```
http://localhost:3000
```

## Fitur Utama
- Multi-session support
- Auto session restoration
- QR Code authentication
- Send text messages
- Send media files (image, video, audio, document)
- Session management (create, delete, reset, reconnect)

---

## Endpoints

### 1. List All Sessions
Mendapatkan daftar semua session yang aktif.

**Endpoint:** `GET /api/sessions`

**Response:**
```json
{
  "success": true,
  "sessions": [
    {
      "sessionId": "session1",
      "isConnected": true,
      "connectionStatus": "connected",
      "hasQR": false,
      "retryCount": 0,
      "user": {
        "id": "6281234567890@s.whatsapp.net",
        "name": "User Name"
      }
    }
  ],
  "total": 1
}
```

---

### 2. Create New Session
Membuat session WhatsApp baru.

**Endpoint:** `POST /api/sessions`

**Request Body:**
```json
{
  "sessionId": "my-session-1"
}
```

**Response Success:**
```json
{
  "success": true,
  "message": "Session initialized successfully",
  "sessionId": "my-session-1"
}
```

**Response Error:**
```json
{
  "success": false,
  "message": "Session already exists"
}
```

---

### 3. Get QR Code
Mendapatkan QR Code untuk login WhatsApp.

**Endpoint:** `GET /api/sessions/:sessionId/qr`

**Response Success:**
```json
{
  "success": true,
  "qr": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
}
```

**Response Error:**
```json
{
  "success": false,
  "message": "QR code not available. Session might be already connected."
}
```

**Note:** QR Code akan expired dalam 20 detik.

---

### 4. Check Session Status
Memeriksa status koneksi session.

**Endpoint:** `GET /api/sessions/:sessionId/status`

**Response:**
```json
{
  "success": true,
  "sessionId": "my-session-1",
  "isConnected": true,
  "connectionStatus": "connected",
  "hasQR": false,
  "retryCount": 0,
  "user": {
    "id": "6281234567890@s.whatsapp.net",
    "name": "User Name"
  }
}
```

**Connection Status:**
- `disconnected`: Tidak terhubung
- `connecting`: Sedang menghubungkan
- `connected`: Terhubung dan siap
- `qr_needed`: Perlu scan QR Code

---

### 5. Send Text Message
Mengirim pesan teks ke nomor WhatsApp.

**Endpoint:** `POST /api/sessions/:sessionId/send-message`

**Request Body:**
```json
{
  "to": "081234567890",
  "message": "Hello, this is a test message!"
}
```

**Response Success:**
```json
{
  "success": true,
  "message": "Message sent successfully",
  "messageId": "3EB0C767D26A1D6E94A4",
  "to": "081234567890"
}
```

**Response Error:**
```json
{
  "success": false,
  "message": "WhatsApp session is not connected"
}
```

**Phone Number Format:**
- Input: `081234567890` atau `+6281234567890`
- Auto format ke: `6281234567890@s.whatsapp.net`

---

### 6. Send Media Message
Mengirim pesan dengan file media (gambar, video, audio, dokumen).

**Endpoint:** `POST /api/sessions/:sessionId/send-media`

**Request:** `multipart/form-data`
- `to`: Nomor telepon tujuan
- `media`: File yang akan dikirim
- `caption`: Caption untuk media (opsional)

**cURL Example:**
```bash
curl -X POST \
  http://localhost:3000/api/sessions/my-session-1/send-media \
  -F "to=081234567890" \
  -F "media=@/path/to/image.jpg" \
  -F "caption=This is an image"
```

**Response Success:**
```json
{
  "success": true,
  "message": "Media sent successfully",
  "messageId": "3EB0C767D26A1D6E94A5",
  "to": "081234567890",
  "mediaType": "image"
}
```

**Supported Media Types:**
- **Image:** `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`
- **Video:** `.mp4`, `.avi`, `.mov`, `.mkv`
- **Audio:** `.mp3`, `.wav`, `.ogg`, `.m4a`
- **Document:** All other files

---

### 7. Force Reconnect Session
Memaksa reconnect session yang bermasalah.

**Endpoint:** `POST /api/sessions/:sessionId/reconnect`

**Response:**
```json
{
  "success": true,
  "message": "Reconnection initiated",
  "sessionId": "my-session-1"
}
```

---

### 8. Reset Session
Reset session dan hapus auth files (perlu scan QR ulang).

**Endpoint:** `POST /api/sessions/:sessionId/reset`

**Response:**
```json
{
  "success": true,
  "message": "Session reset successfully. Please scan new QR code.",
  "sessionId": "my-session-1"
}
```

---

### 9. Delete Session
Menghapus session dan logout dari WhatsApp.

**Endpoint:** `DELETE /api/sessions/:sessionId`

**Response:**
```json
{
  "success": true,
  "message": "Session deleted successfully"
}
```

---

## Usage Flow

### 1. Setup Session Baru
```bash
# 1. Buat session
curl -X POST http://localhost:3000/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "my-session"}'

# 2. Get QR Code
curl http://localhost:3000/api/sessions/my-session/qr

# 3. Scan QR dengan WhatsApp
# 4. Check status
curl http://localhost:3000/api/sessions/my-session/status
```

### 2. Kirim Pesan
```bash
# Text message
curl -X POST http://localhost:3000/api/sessions/my-session/send-message \
  -H "Content-Type: application/json" \
  -d '{
    "to": "081234567890",
    "message": "Hello World!"
  }'

# Media message
curl -X POST http://localhost:3000/api/sessions/my-session/send-media \
  -F "to=081234567890" \
  -F "media=@image.jpg" \
  -F "caption=Check this out!"
```

---

## Error Handling

Semua response menggunakan format standar:

**Success Response:**
```json
{
  "success": true,
  "message": "Operation completed",
  "data": {...}
}
```

**Error Response:**
```json
{
  "success": false,
  "message": "Error description",
  "error": "Detailed error message"
}
```

**HTTP Status Codes:**
- `200` - Success
- `400` - Bad Request (missing parameters)
- `404` - Session not found
- `409` - Conflict (session already exists)
- `500` - Internal Server Error

---

## Troubleshooting

### Session Not Found
```bash
# List all sessions
curl http://localhost:3000/api/sessions

# Restart server to restore sessions from auth folder
```

### Connection Issues
```bash
# Check status
curl http://localhost:3000/api/sessions/my-session/status

# Force reconnect
curl -X POST http://localhost:3000/api/sessions/my-session/reconnect

# Reset session (clean auth)
curl -X POST http://localhost:3000/api/sessions/my-session/reset
```

### QR Code Expired
QR Code akan expired dalam 20 detik. Jika expired:
1. Refresh QR endpoint
2. Atau gunakan reset session

---

## Session Persistence

- Session otomatis tersimpan di folder `./auth/[sessionId]/`
- Saat server restart, session akan otomatis di-restore
- File `sessions.json` menyimpan daftar session aktif

---

## Development Notes

### Folder Structure
```
project/
├── auth/           # WhatsApp auth files (auto-generated)
├── uploads/        # Temporary media files
├── sessions.json   # Active sessions list
└── app.js         # Main application
```

### Environment Variables
```bash
PORT=3000  # Server port (default: 3000)
```

### Dependencies
- `@whiskeysockets/baileys` - WhatsApp Web API
- `express` - Web framework
- `multer` - File upload handling
- `pino` - Logging

---

## Security Notes

⚠️ **Important Security Considerations:**
- Tidak ada authentication pada API endpoints
- Auth files berisi kredensial WhatsApp yang sensitif
- Pastikan tidak expose port ke public tanpa proper security
- Gunakan reverse proxy (nginx) dan SSL untuk production
- Implementasikan rate limiting untuk mencegah spam

---

## Production Deployment

```bash
# Install dependencies
npm install

# Start with PM2
pm2 start app.js --name "whatsapp-api"

# Or with forever
forever start app.js

# Environment production
NODE_ENV=production PORT=3000 node app.js
```
