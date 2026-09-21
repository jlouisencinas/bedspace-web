/**
 * Bedspace Manager mailer. Reviewable copy: the LIVE script is edited in the Google
 * editor (signed in as bedspacemkt@gmail.com) and must be re-deployed (Deploy > Manage
 * deployments > Edit > New version) for changes to reach the /exec URL.
 * Script Property required: MAILER_SECRET  (never commit its value).
 * Called only by the Supabase Edge Function 'notify-email'.
 */
var SENDER_NAME     = 'Bedspace Manager';
var MAX_RECIPIENTS  = 20;      // Gmail allows ~50/message; keep well under
var MAX_SUBJECT_LEN = 200;
var MAX_HTML_LEN    = 50000;
var MAX_TEXT_LEN    = 20000;
var EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function doPost(e) {
  try {
    var expected = PropertiesService.getScriptProperties().getProperty('MAILER_SECRET');
    if (!expected || expected.length < 16) {           // fail closed if unset/weak
      console.error('MAILER_SECRET is not set (or shorter than 16 chars) - refusing all requests');
      return reply_({ ok: false, error: 'unauthorized' });   // don't reveal config state
    }
    var payload;
    try { payload = JSON.parse((e && e.postData && e.postData.contents) || ''); }
    catch (err) { return reply_({ ok: false, error: 'bad_request' }); }

    if (!payload || typeof payload.secret !== 'string' || !safeEqual_(payload.secret, expected)) {
      return reply_({ ok: false, error: 'unauthorized' });
    }
    var v = validate_(payload);
    if (v.error) return reply_({ ok: false, error: 'bad_request', detail: v.error });

    var remaining = MailApp.getRemainingDailyQuota();
    if (remaining < v.recipients.length + 1) {          // +1: conservative for the "to" self-address
      return reply_({ ok: false, error: 'quota_exceeded', quotaRemaining: remaining });
    }
    sendMail_(v.recipients, v.subject, v.html, v.text);
    return reply_({ ok: true, sent: v.recipients.length, quotaRemaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    console.error('doPost failed: ' + err);              // never include the secret
    return reply_({ ok: false, error: 'send_failed' });
  }
}

function sendMail_(recipients, subject, html, text) {
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),          // the sending account; real recipients in BCC
    bcc: recipients.join(','),
    subject: subject,
    htmlBody: html,
    body: text,                                          // plain-text fallback
    name: SENDER_NAME
  });
}

function validate_(p) {
  if (!Array.isArray(p.recipients) || p.recipients.length < 1 || p.recipients.length > MAX_RECIPIENTS) return { error: 'recipients' };
  var seen = {}, list = [];
  for (var i = 0; i < p.recipients.length; i++) {
    var r = p.recipients[i];
    if (typeof r !== 'string') return { error: 'recipients' };
    r = r.trim();
    if (r.length > 254 || !EMAIL_RE.test(r)) return { error: 'recipients' };
    var k = r.toLowerCase();
    if (!seen[k]) { seen[k] = true; list.push(r); }
  }
  if (typeof p.subject !== 'string' || !p.subject.trim() || p.subject.length > MAX_SUBJECT_LEN) return { error: 'subject' };
  if (typeof p.html !== 'string' || !p.html.trim() || p.html.length > MAX_HTML_LEN) return { error: 'html' };
  var text = (typeof p.text === 'string' && p.text.trim()) ? p.text
           : p.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > MAX_TEXT_LEN) text = text.substring(0, MAX_TEXT_LEN);
  return { recipients: list, subject: p.subject.replace(/[\r\n]+/g, ' ').trim(), html: p.html, text: text };
}

function safeEqual_(a, b) {                              // length-checked, no early exit on content
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run ONCE from the editor: triggers the Google consent screen for sending mail. */
function authorizeMailer() {
  Logger.log('Authorised. Sender: ' + Session.getEffectiveUser().getEmail() +
             ' | remaining daily recipient quota: ' + MailApp.getRemainingDailyQuota());
}

/** Run from the editor: sends a test message to the sending account itself (no hardcoded recipients). */
function testMailer() {
  var me = Session.getEffectiveUser().getEmail();
  sendMail_([me], '[TEST] Bedspace Mailer script test',
    '<p>The Bedspace mailer script can send mail.</p>', 'The Bedspace mailer script can send mail.');
  Logger.log('Test message sent to ' + me);
}
