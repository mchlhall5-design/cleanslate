CleanSlate V7 Resumable Full Mailbox

Upload this ZIP to the SAME Netlify site you are using:
https://wondrous-taffy-64bd9d.netlify.app

Do not create a new Google project or OAuth client unless required.

What changed:
- Full mailbox Gmail pagination using nextPageToken
- Resumable scan state saved locally
- IndexedDB sender storage instead of holding all emails in memory
- Pause / resume scan
- Reset saved scan
- Protected important senders pinned at top as KEEP SAFE
- Select all unsafe senders with unsubscribe links
- Automatic unsubscribe attempts using List-Unsubscribe mailto/URL
- CAPTCHA/login/SMS pages cannot be bypassed and may still need manual review

Important:
Mobile Chrome on iPhone uses the same Apple WebKit engine as Safari, so the fix is chunked scanning/resume storage, not simply changing browsers.


V8 added:
- Delete Emails From Selected Senders
- Archive Emails From Selected Senders
- Resume Saved Cleanup
- Pause Cleanup
- Uses Gmail batchModify in chunks
- DELETE means move to Gmail Trash, not permanent erase
- Safe/protected senders are excluded from delete/archive actions
