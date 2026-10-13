# ASTRO X ULTRA Public Session Website — Render

This standalone website lets anyone open the public page, enter a WhatsApp number with country code, receive a pairing code, and link their own WhatsApp account. After linking, it sends an `ASTRO X:~` SESSION_ID compatible with Astro X Ultra to that account's WhatsApp self-chat. The website never displays or returns the SESSION_ID. It does not deploy or replace the Astro X Ultra WhatsApp bot.

The page uses the provided ASTRO commander artwork in its hero area, with a matching dark-and-gold visual theme.

## Deploy the public site on Render

1. Extract this ZIP.
2. Push the extracted project files to a GitHub repository that Render can access. Render Blueprints deploy from a Git repository; this ZIP is the source bundle, not a live deployment.
3. In Render, choose **New → Blueprint**, connect that repository, and apply its `render.yaml`.
4. Render will create the public web service `astro-x-ultra-session-generator`. Open the service’s assigned `onrender.com` URL after the first deploy completes.
5. No Telegram bot token or API key is required. The website is public; anyone can submit a pairing request.

The Blueprint uses Render’s `free` web-service plan. Free services may sleep after inactivity, so the first visit or pairing request after idle time can take longer while Render wakes the service. Check the current [Render free plan details](https://render.com/docs/free) before deployment.

## Use the website

1. Visit the Render URL over HTTPS.
2. Enter the WhatsApp phone number with country code.
3. Confirm you own or are authorized to link that account.
4. Use **Copy pairing code** (or select the code manually), then enter it in WhatsApp under **Linked Devices → Link a Device → Link with phone number**. **Open WhatsApp Web** is also available as a shortcut.
5. When pairing finishes, open **Message yourself** in the linked WhatsApp account and find the SESSION_ID message. Copy it privately and add it to your Astro X Ultra deployment as `SESSION_ID`.

The public service allows at most 30 new requests per hour globally, five per IP per hour, one active request per IP, a five-minute cooldown per phone number, and two active sessions at a time. Pairing requests expire automatically. Temporary Baileys credential files are removed after completion, cancellation, or expiry. Leaving the page attempts cancellation; if that request cannot finish, expiry is the cleanup fallback. A forced process kill may leave a private temporary directory until the next startup sweep (directories older than one hour are removed). Each page request uses a browser-generated random access token for polling and cancellation; the token is not placed in the request URL. Retrying a submission with the same number in the same page safely resumes if the POST response was lost. On successful pairing, the SESSION_ID is sent directly from the WhatsApp connection to the linked account's self-chat; it is not sent in the website response or retained in server memory afterward. Keep the received message private: the value can provide access to the linked account.

Request/rate-limit state is in memory. Render restarts or free-service sleeps can clear active requests and rate limits; do not rely on an in-progress pairing surviving a restart. A SESSION_ID delivered to WhatsApp is your responsibility to store securely.

## Configuration

`SESSION_PREFIX` defaults to `ASTRO X:~`. The active-session and per-IP/global hourly request limits are set in the Render Blueprint and can be changed in service environment settings. The service does not write phone numbers, request tokens, or SESSION_ID values to an application log or database.
