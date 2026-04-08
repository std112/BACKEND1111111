const express = require('express');
const axios = require('axios');
const fs = require('fs');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = 3000;
const STEAM_API_KEY = '50B1B86F5B470A927F612C17F9A8DB73';

// Load balances from file
function loadBalances() {
  try {
    return JSON.parse(fs.readFileSync('db.json', 'utf8'));
  } catch (err) {
    console.error('Failed to load db.json:', err.message);
    return {};
  }
}

// Save balances to file
function saveBalances(balances) {
  fs.writeFileSync('db.json', JSON.stringify(balances, null, 2));
}

// Ensure a user record has all required fields
function ensureUserDefaults(user = {}) {
  return {
    balance: typeof user.balance === 'number' ? user.balance : 0,
    banned: user.banned === true,
    warning: user.warning || ''
  };
}

// Resolve SteamID from profile URL
async function getSteamID(steamUrl) {
  if (!steamUrl || typeof steamUrl !== 'string') {
    throw new Error('Invalid Steam URL');
  }

  const clean = steamUrl.trim().replace(/\/$/, '');

  if (clean.includes('/id/')) {
    const customId = clean.split('/id/')[1].split('/')[0];
    if (!customId) throw new Error('Could not parse custom Steam ID');
    const res = await axios.get(
      `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_API_KEY}&vanityurl=${customId}`
    );
    const data = res.data.response;
    if (data.success !== 1) throw new Error('Steam vanity URL not found');
    return data.steamid;
  } else if (clean.includes('/profiles/')) {
    const id = clean.split('/profiles/')[1].split('/')[0];
    if (!id) throw new Error('Could not parse Steam profile ID');
    return id;
  } else {
    throw new Error('Invalid Steam URL format. Use /profiles/ or /id/ URLs.');
  }
}

// ──────────────────────────────────────────────
// User Routes
// ──────────────────────────────────────────────

// Main route: Fetch Steam info
app.post('/api/steam-info', async (req, res) => {
  const { steamUrl } = req.body;

  if (!steamUrl) {
    return res.status(400).json({ error: 'Missing steamUrl' });
  }

  try {
    const steamId = await getSteamID(steamUrl);
    const balances = loadBalances();

    // Ensure user record exists with all defaults
    if (!balances[steamId]) {
      balances[steamId] = ensureUserDefaults();
      saveBalances(balances);
    } else {
      balances[steamId] = ensureUserDefaults(balances[steamId]);
      saveBalances(balances);
    }

    // If banned, deny access
    if (balances[steamId].banned) {
      return res.status(403).json({ error: 'This user is banned.' });
    }

    const [profileRes, levelRes] = await Promise.all([
      axios.get(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`),
      axios.get(`https://api.steampowered.com/IPlayerService/GetSteamLevel/v1/?key=${STEAM_API_KEY}&steamid=${steamId}`)
    ]);

    const players = profileRes.data?.response?.players;
    if (!players || players.length === 0) {
      return res.status(404).json({ error: 'Steam profile not found' });
    }

    const player = players[0];
    const level = levelRes.data?.response?.player_level ?? 0;

    res.json({
      steamId,
      personaName: player.personaname,
      avatar: player.avatarfull,
      level,
      balance: balances[steamId].balance,
      warning: balances[steamId].warning
    });

  } catch (err) {
    console.error('steam-info error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to fetch Steam info' });
  }
});

// Frontend: Get warning message for current user
app.post('/api/get-warning', (req, res) => {
  const { steamId } = req.body;

  if (!steamId) {
    return res.status(400).json({ error: 'Missing steamId' });
  }

  const balances = loadBalances();
  const warning = balances[steamId]?.warning || '';

  res.json({ warning });
});

// ──────────────────────────────────────────────
// Admin Routes
// ──────────────────────────────────────────────

// Admin: Get all users
app.get('/api/users', (req, res) => {
  const balances = loadBalances();
  res.json(balances);
});

// Admin: Update only balance
app.post('/api/update-balance', (req, res) => {
  const { steamId, balance } = req.body;

  if (!steamId || typeof balance !== 'number') {
    return res.status(400).json({ error: 'Invalid data: steamId and numeric balance required' });
  }

  const balances = loadBalances();
  balances[steamId] = ensureUserDefaults(balances[steamId]);
  balances[steamId].balance = balance;
  saveBalances(balances);

  res.json({ success: true });
});

// Admin: Update balance + warning
app.post('/api/update-user', (req, res) => {
  const { steamId, balance, warning } = req.body;

  if (!steamId) return res.status(400).json({ error: 'Missing steamId' });

  const balances = loadBalances();
  balances[steamId] = ensureUserDefaults(balances[steamId]);
  balances[steamId].balance = typeof balance === 'number' ? balance : balances[steamId].balance;
  balances[steamId].warning = warning !== undefined ? warning : balances[steamId].warning;
  saveBalances(balances);

  res.json({ success: true });
});

// Admin: Toggle ban status
app.post('/api/toggle-ban', (req, res) => {
  const { steamId } = req.body;

  if (!steamId) return res.status(400).json({ error: 'Missing steamId' });

  const balances = loadBalances();
  balances[steamId] = ensureUserDefaults(balances[steamId]);
  balances[steamId].banned = !balances[steamId].banned;
  saveBalances(balances);

  res.json({ banned: balances[steamId].banned });
});

// Admin: Remove a user completely
app.post('/api/remove-user', (req, res) => {
  const { steamId } = req.body;

  if (!steamId) {
    return res.status(400).json({ error: 'Missing steamId' });
  }

  const balances = loadBalances();
  if (balances[steamId]) {
    delete balances[steamId];
    saveBalances(balances);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

// Admin: Add a new user manually
app.post('/api/add-user', async (req, res) => {
  const { steamUrl, balance, warning } = req.body;

  if (!steamUrl) return res.status(400).json({ error: 'Missing Steam profile URL' });

  try {
    const steamId = await getSteamID(steamUrl);
    const balances = loadBalances();

    balances[steamId] = {
      balance: typeof balance === 'number' ? balance : 0,
      warning: warning || '',
      banned: false
    };

    saveBalances(balances);
    res.json({ success: true, steamId });
  } catch (err) {
    console.error('add-user error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to resolve Steam ID' });
  }
});

// ──────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Backend running at http://localhost:${PORT}`);
});
