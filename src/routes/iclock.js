'use strict';
// Receives scans from ZKTeco fingerprint terminals over the school network ("ADMS" or
// "Cloud server" setting on the device, also called the push protocol). The device calls:
//   GET  /iclock/cdata?SN=...            on start: asks for its settings
//   POST /iclock/cdata?SN=...&table=ATTLOG  sends attendance lines "staff number <tab> date time ..."
//   GET  /iclock/getrequest?SN=...       every few seconds: asks for commands (we send none)
//   POST /iclock/devicecmd?SN=...        reports on commands
//
// These requests carry no password (the device cannot sign in), so:
//  - a device the portal has never seen is recorded as "waiting for approval", and its scans
//    are kept but count for nothing until an administrator approves the device;
//  - an approved device can be tied to one network address;
//  - nothing else in the portal is reachable this way, and no session or cookie is used.
// Fingerprints never arrive here: the device keeps them. User and fingerprint records the device
// may send (table=OPERLOG, BIODATA...) are acknowledged and thrown away without being stored.
const express = require('express');
const db = require('../db');
const log = require('../log');
const scanner = require('../scanner');

const r = express.Router();
r.use('/iclock', express.text({ type: () => true, limit: '1mb' }));

const SERIAL = /^[A-Za-z0-9_-]{4,40}$/;
const MAX_PENDING = 20;

function clientIp(req) { return String(req.ip || '').replace(/^::ffff:/, ''); }

// Finds or registers the device; returns null when the request must be refused.
function device(req) {
  const serial = String(req.query.SN || '');
  if (!SERIAL.test(serial)) return null;
  const d = db.get();
  let dev = d.prepare('SELECT * FROM scan_devices WHERE serial = ?').get(serial);
  const ip = clientIp(req);
  if (!dev) {
    if (d.prepare("SELECT COUNT(*) n FROM scan_devices WHERE status = 'pending'").get().n >= MAX_PENDING) return null;
    d.prepare('INSERT INTO scan_devices (serial, name, last_ip, last_seen_at) VALUES (?, ?, ?, datetime(\'now\'))').run(serial, `Scanner ${serial.slice(-4)}`, ip);
    db.audit({ entity: 'scan_device', action: 'detected', after: { serial, ip } });
    log.info('new fingerprint scanner waiting for approval', { serial, ip });
    dev = d.prepare('SELECT * FROM scan_devices WHERE serial = ?').get(serial);
  } else {
    if (dev.allowed_ip && dev.allowed_ip !== ip) {
      log.warn('scanner request from an address that is not allowed', { serial, ip });
      return null;
    }
    d.prepare("UPDATE scan_devices SET last_seen_at = datetime('now'), last_ip = ? WHERE id = ?").run(ip, dev.id);
  }
  return dev;
}

const plain = (res, text, status = 200) => res.status(status).type('text/plain').set('Cache-Control', 'no-store').send(text);

r.get('/iclock/cdata', (req, res) => {
  const dev = device(req);
  if (!dev) return plain(res, 'ERROR', 403);
  // Ask for attendance lines only, in real time, and never for photos or fingerprint templates.
  plain(res, [
    `GET OPTION FROM: ${dev.serial}`,
    'ATTLOGStamp=None', 'OPERLOGStamp=9999', 'ATTPHOTOStamp=None',
    'ErrorDelay=60', 'Delay=10', 'TransTimes=00:00;12:00', 'TransInterval=1',
    'TransFlag=TransData AttLog', 'Realtime=1', 'Encrypt=None', 'TimeZone=1',
  ].join('\n'));
});

r.post('/iclock/cdata', (req, res) => {
  const dev = device(req);
  if (!dev) return plain(res, 'ERROR', 403);
  const table = String(req.query.table || '').toUpperCase();
  if (table !== 'ATTLOG') return plain(res, 'OK'); // user lists, fingerprints, photos: not stored
  const { scans } = scanner.parseLog(typeof req.body === 'string' ? req.body : '');
  if (dev.status === 'disabled') return plain(res, `OK: ${scans.length}`);
  const result = scanner.addScans(scans, { deviceId: dev.id, source: 'device' });
  // A scan dated in the future means the device clock is ahead: warn the administrator.
  const now = scanner.nowIn(db.getSettings().timezone);
  const nowStamp = `${now.date} ${now.time}`;
  const ahead = scans.filter((s) => s.scanned_at > nowStamp).map((s) => Math.round((Date.parse(s.scanned_at.replace(' ', 'T')) - Date.parse(nowStamp.replace(' ', 'T'))) / 60000));
  if (ahead.length) db.get().prepare('UPDATE scan_devices SET clock_ahead_min = ? WHERE id = ?').run(Math.max(...ahead), dev.id);
  else if (scans.length) db.get().prepare('UPDATE scan_devices SET clock_ahead_min = NULL WHERE id = ?').run(dev.id);
  log.info('scanner sent attendance', { serial: dev.serial, lines: scans.length, added: result.added, active: dev.status === 'active' });
  plain(res, `OK: ${scans.length}`);
});

r.get('/iclock/getrequest', (req, res) => (device(req) ? plain(res, 'OK') : plain(res, 'ERROR', 403)));
r.post('/iclock/devicecmd', (req, res) => (device(req) ? plain(res, 'OK') : plain(res, 'ERROR', 403)));

module.exports = r;
