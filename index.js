const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const qrcode = require('qrcode');
const axios = require('axios');
const http = require('http');

const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock;
let qrCodeData = '';
let connectionStatus = 'disconnected';
let userPhone = '';

// Ganti dengan URL webhook CRM PHP Anda di InfinityFree
const CRM_WEBHOOK_URL = 'https://simpswhatsappcrm.kesug.com/webhook.php';

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = qr;
            connectionStatus = 'qr_ready';
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus, menghubungkan kembali:', shouldReconnect);
            connectionStatus = 'disconnected';
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Terhubung ke WhatsApp!');
            connectionStatus = 'connected';
            qrCodeData = '';
            if (sock.user && sock.user.id) {
                userPhone = sock.user.id.split(':')[0];
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Tangkap Pesan Masuk & Teruskan ke CRM PHP
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const sender = msg.key.remoteJid.replace('@s.whatsapp.net', '');
            const message = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            const pushName = msg.pushName || 'Prospek WA';

            if (message) {
                try {
                    await axios.post(CRM_WEBHOOK_URL, {
                        sender: sender,
                        message: message,
                        name: pushName
                    });
                    console.log(`Pesan dari ${sender} diteruskan ke CRM.`);
                } catch (error) {
                    console.error('Gagal mengirim webhook ke CRM:', error.message);
                }
            }
        }
    });
}

connectToWhatsApp();

// Endpoint untuk mengecek status
app.get('/', (req, res) => {
    res.json({
        status: connectionStatus,
        phone: userPhone
    });
});

// Endpoint untuk menampilkan QR Code di browser / CRM
app.get('/qr', async (req, res) => {
    if (connectionStatus === 'connected') {
        return res.send('<h3 style="font-family:sans-serif; text-align:center; color:green; margin-top:50px;">✔ WhatsApp Anda sudah terhubung!</h3>');
    }
    if (qrCodeData) {
        try {
            const url = await qrcode.toDataURL(qrCodeData);
            res.send(`<div style="text-align:center; margin-top:50px; font-family:sans-serif;"><h2>Scan QR WhatsApp CRM</h2><img src="${url}" style="width:280px;height:280px;"/><p>Status: ${connectionStatus}</p></div>`);
        } catch (err) {
            res.status(500).send('Gagal generate QR Code');
        }
    } else {
        res.send('<h3 style="font-family:sans-serif; text-align:center; margin-top:50px;">⏳ QR Code sedang disiapkan, silakan refresh halaman ini beberapa saat lagi...</h3>');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Gateway berjalan di port ${PORT}`);
});
