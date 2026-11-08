'use strict';
// Email (OTP codes) and SMS (motion alerts).
//
// Real email: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM and run `npm install`
// (installs nodemailer). For Gmail use smtp.gmail.com, port 465 and an App Password.
// Without SMTP settings, messages go to the outbox/ folder so the demo works offline.
//
// SMS: the proposal used a GSM module. Here SMS is written to outbox/ too; in production you'd
// plug in an SMS gateway (e.g. Twilio) or a GSM modem in sendSms().
const fs = require('node:fs');
const path = require('node:path');

const OUTBOX = path.join(__dirname, '..', 'outbox');
let transporter = null;

if (process.env.SMTP_HOST) {
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  } catch {
    console.warn('SMTP_HOST is set but nodemailer is not installed. Run `npm install`. Using outbox/ instead.');
  }
}

function toOutbox(kind, to, subject, text) {
  fs.mkdirSync(OUTBOX, { recursive: true, mode: 0o700 });
  const file = path.join(OUTBOX, `${kind}-${Date.now()}.txt`);
  fs.writeFileSync(file, `To: ${to}\nSubject: ${subject}\nDate: ${new Date().toISOString()}\n\n${text}\n`, { mode: 0o600 });
  return file;
}

async function sendEmail(to, subject, text) {
  if (transporter) {
    await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
    return 'smtp';
  }
  const file = toOutbox('email', to, subject, text);
  console.log(`[dev email] to ${to}: "${subject}" -> ${path.relative(process.cwd(), file)}`);
  return 'outbox';
}

async function sendSms(to, text) {
  const file = toOutbox('sms', to, 'SMS', text);
  console.log(`[dev sms]   to ${to}: "${text}" -> ${path.relative(process.cwd(), file)}`);
  return 'outbox';
}

module.exports = { sendEmail, sendSms, OUTBOX };
