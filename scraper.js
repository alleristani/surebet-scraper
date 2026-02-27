const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

// CONFIG (da Secrets GitHub Actions)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'default_secret';

// 10 Bookmaker configurati (con selettori CSS approssimativi)
const BOOKIES = [
  { nome: 'BetFlag', url: 'https://www.betflag.it/scommesse/calcio', selector: '.odds-value, .quota' },
  { nome: 'Staryes', url: 'https://www.staryes.it/calcio', selector: '.quote, .odds' },
  { nome: 'Eurobet', url: 'https://www.eurobet.it/it/scommesse/calcio', selector: '.odd-value, .odds' },
  { nome: 'Goldbet', url: 'https://www.goldbet.it/scommesse/calcio', selector: '.quota-value, .quota' },
  { nome: 'BetfairSB', url: 'https://www.betfair.it/sport/calcio', selector: '.price, .odds' },
  { nome: 'WilliamHill', url: 'https://www.williamhill.it/it/sports/calcio', selector: '.odds, .price' },
  { nome: 'Gioca7', url: 'https://www.gioca7.it/calcio', selector: '.quota, .odd' },
  { nome: 'Netwin', url: 'https://www.netwin.it/scommesse/calcio', selector: '.odds-val, .quota' },
  { nome: 'Vincitu', url: 'https://www.vincitu.it/scommesse/calcio', selector: '.odds, .quota' },
  { nome: 'Marathon', url: 'https://www.marathonbet.it/su/betting/Football', selector: '.selection-link, .price' }
];

// Funzione scraping singolo bookie
async function scrapeBookie(bookie) {
  console.log(`\nScraping ${bookie.nome}...`);
  let browser;
  
  try {
    browser = await puppeteer.launch({ 
      headless: 'new', 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    await page.goto(bookie.url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Estrae quote (esempio generico, da raffinare per ogni sito)
    const odds = await page.evaluate((sel) => {
      const elements = Array.from(document.querySelectorAll(sel));
      return elements.slice(0, 10).map(el => {
        const text = el.textContent.trim();
        const match = text.match(/\d+\.\d+/);
        return match ? parseFloat(match[0]) : null;
      }).filter(q => q && q > 1.01 && q < 50);
    }, bookie.selector);
    
    console.log(`${bookie.nome}: trovate ${odds.length} quote`);
    
    await browser.close();
    return { bookie: bookie.nome, odds, timestamp: new Date().toISOString() };
    
  } catch (error) {
    console.error(`Errore ${bookie.nome}:`, error.message);
    if (browser) await browser.close();
    return { bookie: bookie.nome, odds: [], timestamp: new Date().toISOString(), error: error.message };
  }
}

// Calcola surebet tra 2 bookies
function calculateSurebets(allOdds) {
  const surebets = [];
  
  // Confronta ogni coppia di bookies
  for (let i = 0; i < allOdds.length; i++) {
    for (let j = i + 1; j < allOdds.length; j++) {
      const bookie1 = allOdds[i];
      const bookie2 = allOdds[j];
      
      // Confronta tutte le quote
      for (const q1 of bookie1.odds) {
        for (const q2 of bookie2.odds) {
          // Formula surebet: 1/q1 + 1/q2 < 0.98 (margine 2%)
          const inversa = (1 / q1) + (1 / q2);
          
          if (inversa < 0.98) {
            const roi = ((1 - inversa) * 100).toFixed(2);
            const capitale = 500; // Default €500
            const stake1 = Math.round((capitale / q1) / inversa);
            const stake2 = capitale - stake1;
            const profit = (stake1 * (q1 - 1)).toFixed(2);
            
            surebets.push({
              market: 'Calcio - Generico',
              sport: 'calcio',
              evento: `Match ${i + 1}`,
              bookie1: bookie1.bookie,
              quote1: q1,
              bookie2: bookie2.bookie,
              quote2: q2,
              roi: parseFloat(roi),
              profit: parseFloat(profit),
              stake_totale: capitale,
              stake1,
              stake2,
              mercato_tipo: '1X2',
              attiva: true,
              created_at: new Date().toISOString()
            });
          }
        }
      }
    }
  }
  
  return surebets.sort((a, b) => b.roi - a.roi).slice(0, 20); // Top 20
}

// Salva su Supabase
async function saveToSupabase(surebets, oddsHistory) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Mancano SUPABASE_URL o SUPABASE_KEY');
    return;
  }
  
  // Insert odds_history
  if (oddsHistory.length > 0) {
    try {
      const oddsPayload = oddsHistory.map(o => ({
        bookie: o.bookie,
        evento: 'Match Generico',
        sport: 'calcio',
        mercato: '1X2',
        quota_1: o.odds[0] || null,
        quota_x: o.odds[1] || null,
        quota_2: o.odds[2] || null,
        timestamp: o.timestamp
      }));
      
      const oddsRes = await fetch(`${SUPABASE_URL}/rest/v1/odds_history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(oddsPayload)
      });
      
      console.log(`\nOdds salvate: ${oddsRes.ok ? 'OK' : 'ERRORE ' + oddsRes.status}`);
    } catch (err) {
      console.error('Errore salvataggio odds:', err.message);
    }
  }
  
  // Insert surebets
  if (surebets.length > 0) {
    try {
      const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/surebets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(surebets)
      });
      
      console.log(`Surebets salvate: ${sbRes.ok ? 'OK' : 'ERRORE ' + sbRes.status}`);
    } catch (err) {
      console.error('Errore salvataggio surebets:', err.message);
    }
  }
}

// MAIN
async function main() {
  console.log('=== SUREBET SCANNER AVVIATO ===');
  console.log(`Data: ${new Date().toLocaleString('it-IT')}\n`);
  
  // Scrape tutti i bookies in parallelo (max 3 alla volta per evitare ban)
  const results = [];
  for (let i = 0; i < BOOKIES.length; i += 3) {
    const batch = BOOKIES.slice(i, i + 3);
    const batchResults = await Promise.all(batch.map(b => scrapeBookie(b)));
    results.push(...batchResults);
    
    // Pausa 2s tra batch
    if (i + 3 < BOOKIES.length) {
      console.log('\nPausa 2s...');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  const validResults = results.filter(r => r.odds.length > 0);
  console.log(`\n=== SCRAPING COMPLETATO: ${validResults.length}/${BOOKIES.length} bookies OK ===\n`);
  
  // Calcola surebet
  const surebets = calculateSurebets(validResults);
  console.log(`SUREBET TROVATE: ${surebets.length}\n`);
  
  if (surebets.length > 0) {
    console.log('Top 5 Surebet:');
    surebets.slice(0, 5).forEach((sb, idx) => {
      console.log(`${idx + 1}. ${sb.bookie1} ${sb.quote1} vs ${sb.bookie2} ${sb.quote2} | ROI: ${sb.roi}% | Profit: €${sb.profit}`);
    });
  }
  
  // Salva su Supabase
  await saveToSupabase(surebets, validResults);
  
  console.log('\n=== SCAN COMPLETATO ===');
  process.exit(0);
}

main().catch(err => {
  console.error('ERRORE FATALE:', err);
  process.exit(1);
});
