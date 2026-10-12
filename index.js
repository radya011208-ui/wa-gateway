const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());

// --- GANTI DENGAN DOMAIN INFINITYFREE KAMU ---
const CRM_WEBHOOK_URL = 'https://simpswhatsappcrm.kesug.com/webhook.php';

let sock;
let qrCodeData = '';
let connectionStatus = 'Connecting';

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = qr;
            connectionStatus = 'QR Generated';
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus, mencoba menghubungkan kembali...', shouldReconnect);
            connectionStatus = 'Disconnected';
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp Berhasil Terhubung!');
            connectionStatus = 'Connected';
            qrCodeData = '';
        }
    });

    // Tangkap Pesan Masuk & Teruskan ke CRM PHP (Dilengkapi Debug Respon)
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            let rawSender = msg.key.participant || msg.key.remoteJid || '';
            let sender = rawSender.split('@')[0].split(':')[0];
            
            const message = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            const pushName = msg.pushName || 'Prospek WA';

            if (message && sender) {
                try {
                    const response = await axios.post(CRM_WEBHOOK_URL, {
                        sender: sender,
                        message: message,
                        name: pushName
                    });
                    console.log(`Pesan dari ${sender} diteruskan ke CRM.`);
                    console.log('Respon dari CRM:', response.data); // Cek bagian ini di Log Railway nanti
                } catch (error) {
                    console.error('Gagal mengirim webhook ke CRM:', error.message);
                }
            }
        }
    });
}

// Endpoint untuk menampilkan halaman /qr di Browser / Iframe CRM
app.get('/qr', async (req, res) => {
    if (connectionStatus === 'Connected') {
        return res.send('<h3 style="font-family:sans-serif; text-align:center; color:green; margin-top:50px;">✔ WhatsApp Anda sudah terhubung!</h3>');
    }
    if (!qrCodeData) {
        return res.send('<h3 style="font-family:sans-serif; text-align:center; color:gray; margin-top:50px;">⏳ QR Code sedang disiapkan, muat ulang halaman...</h3><script>setTimeout(() => location.reload(), 3000);</script>');
    }
    try {
        const qrImage = await qrcode.toDataURL(qrCodeData);
        res.send(`
            <div style="text-align:center; font-family:sans-serif; margin-top:30px;">
                <h3>Scan QR Code WhatsApp</h3>
                <img src="${qrImage}" style="width:280px; height:280px;" />
                <p style="color:gray; font-size:12px;">Scan menggunakan aplikasi WhatsApp di HP Anda</p>
                <script>setTimeout(() => location.reload(), 20000);</script>
            </div>
        `);
    } catch (err) {
        res.status(500).send('Gagal memuat QR Code');
    }
});

// Endpoint untuk mengirim pesan balasan dari CRM PHP
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) {
        return res.status(400).json({ status: false, message: 'Nomor dan pesan wajib diisi' });
    }
    try {
        const formattedPhone = phone.includes('@s.whatsapp.net') ? phone : `${phone}@s.whatsapp.net`;
        await sock.sendMessage(formattedPhone, { text: message });
        res.json({ status: true, message: 'Pesan berhasil dikirim' });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server WA Gateway berjalan di port ${PORT}`);
    connectToWhatsApp();
});
