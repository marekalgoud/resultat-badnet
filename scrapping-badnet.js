const assert = require('assert');
const { chromium } = require('playwright');

const EVENT_ID = process.env.EVENT_ID || '51200'; // Remplace par ton ID d'événement si nécessaire
const TOURNAMENT_NAME = process.env.TOURNAMENT_NAME || '';

const STATUS_PRIORITY = {
  Vainqueurs: 5,
  Finalistes: 4,
  'Demi-finalistes': 3,
  '2ième': 4,
  '3ieme': 3,
  'Quart de finale': 2,
  Poules: 1,
  'Non trouve': 0,
};

function cleanPlayerName(name) {
  return (name || '')
    .replace(/\baccount_circle\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForMatch(name) {
  return cleanPlayerName(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function toSeriesKey(discipline) {
  const normalized = normalizeForMatch(discipline);
  const match = normalized.match(/(DD|DH|DI|MX|SD|SH|SI)\s*S?\d*/);
  return match ? match[0] : normalized;
}

function toDrawSeriesKey(label) {
  const normalized = normalizeForMatch(label);
  if (/^SIMPLE\s+HOMME\b/.test(normalized)) {
    return 'SH';
  }
  if (/^SIMPLE\s+DAME\b/.test(normalized)) {
    return 'SD';
  }
  if (/^SIMPLE\s+INTERGENRE\b/.test(normalized)) {
    return 'SI';
  }
  if (/^DOUBLE\s+HOMME\b/.test(normalized)) {
    return 'DH';
  }
  if (/^DOUBLE\s+DAME\b/.test(normalized)) {
    return 'DD';
  }
  if (/^DOUBLE\s+INTERGENRE\b/.test(normalized)) {
    return 'DI';
  }
  if (/^MIXTE\b/.test(normalized)) {
    return 'MX';
  }
  return toSeriesKey(label).replace(/\s+.*$/, '');
}

function ensureTableauxEntry(map, playerKey) {
  if (!map.has(playerKey)) {
    map.set(playerKey, {
      quarterDraws: new Set(),
      poolResults: [],
    });
  }
  return map.get(playerKey);
}

function canonicalizeTableauxUrl(rawUrl) {
  const value = (rawUrl || '')
    .replace(/&amp;|&#38;|\\u0026/g, '&')
    .replace(/\\\//g, '/');
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value, 'https://badnet.fr');
    if (url.hostname === 'badnet.frtournoi') {
      url.hostname = 'badnet.fr';
      if (!url.pathname.startsWith('/tournoi/')) {
        url.pathname = `/tournoi${url.pathname}`;
      }
    }
    return url.toString();
  } catch {
    return '';
  }
}

async function findUnknownPlayersInTableaux(page, unknownPlayers) {
  const unknownNormalized = unknownPlayers.map((p) => normalizeForMatch(p)).filter(Boolean);
  const byPlayer = new Map();
  const phaseUrls = new Set();
  const collectPhaseUrl = (rawUrl) => {
    let urlValue = rawUrl;
    if (urlValue.trim().startsWith('{')) {
      try {
        urlValue = JSON.parse(urlValue).url || '';
      } catch {
        urlValue = '';
      }
    }
    const normalizedUrl = canonicalizeTableauxUrl(urlValue);
    const parsedUrl = normalizedUrl ? new URL(normalizedUrl) : null;
    const route = parsedUrl ? `${parsedUrl.pathname}${parsedUrl.search}` : '';
    if (/^\/tournoi\/public\/tableaux\?/.test(route) && /[?&]drawid=/.test(route) && /[?&]phaseid=/.test(route)) {
      phaseUrls.add(normalizedUrl);
    }
  };

  if (unknownNormalized.length === 0) {
    return byPlayer;
  }

  page.on('response', (response) => collectPhaseUrl(response.url()));

  const parseCurrentTableauxPage = async (label) => {
    const pageResults = await page.evaluate(
      ({ targets, label }) => {
        const clean = (raw) => (raw || '').replace(/\baccount_circle\b/gi, '').replace(/\s+/g, ' ').trim();
        const normalize = (raw) => clean(raw).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
        const out = [];
        for (const table of Array.from(document.querySelectorAll('table')).filter((element) => !element.classList.contains('matchs'))) {
          const rows = Array.from(table.querySelectorAll('tr')).filter((row) => row.querySelectorAll('td').length > 0);
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td'));
            const names = Array.from(row.querySelectorAll('p.popup, .player-infos')).map((node) => clean(node.textContent || '')).filter(Boolean);
            if (names.length === 0) continue;
            const rank = Number.parseInt((clean(cells[cells.length - 1]?.textContent || '').match(/\d+/) || [''])[0], 10);
            for (const target of targets) {
              if (names.some((name) => { const key = normalize(name); return key === target || key.includes(target) || target.includes(key); })) {
                const detail = clean(table.closest('section')?.querySelector('h3')?.textContent || table.parentElement?.querySelector('h3')?.textContent || label);
                out.push({ normalizedName: target, status: 'Poules', detail, wins: '', clt: '', rank: Number.isFinite(rank) ? rank : -1, uniquePool: /POULE UNIQUE/i.test(normalize(table.parentElement?.textContent || '')) });
              }
            }
          }
        }
        return out;
      },
      { targets: unknownNormalized, label }
    );
    for (const match of pageResults) {
      const entry = ensureTableauxEntry(byPlayer, match.normalizedName);
      if (!entry.poolResults.some((pool) => pool.drawLabel === match.detail && pool.rank === match.rank)) {
        entry.poolResults.push({ drawLabel: match.detail, wins: match.wins, clt: match.clt, rank: match.rank, uniquePool: match.uniquePool, winsValue: -1, cltValue: 99 });
      }
    }
  };

  await page.goto(`https://badnet.fr/tournoi/public/tableaux?eventid=${EVENT_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  await page
    .locator('a[href*="drawid="], [data-ic_url*="drawid"], [data-url*="drawid"], [data-href*="drawid"]')
    .first()
    .waitFor({ state: 'attached', timeout: 10000 })
    .catch(async () => {
      await page.locator('table').first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    });

  const drawsData = await page.evaluate(() => {
    const decodeUrl = (rawUrl) => {
      let value = rawUrl;
      if (value.trim().startsWith('{')) {
        try {
          value = JSON.parse(value).url || '';
        } catch {
          value = '';
        }
      }
      return value
        .replace(/&amp;|&#38;|\\u0026/g, '&')
        .replace(/&quot;|&#34;/g, '"');
    };
    const links = Array.from(document.querySelectorAll('#content_draws a, #content_draws button, #content_draws .draw-link, a.draw-link, button.draw-link, a[href*="drawid="], [data-ic_url*="drawid"], [data-url*="drawid"], [data-href*="drawid"]'));
    const normalizedHtml = document.documentElement.innerHTML.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
    const htmlUrls = Array.from(normalizedHtml.matchAll(/(?:https?:\/\/badnet\.fr)?\/tournoi\/public\/tableaux\?[^"'\s<>]+/g))
      .map((match) => decodeUrl(match[0]))
      .filter((href) => /[?&]drawid=/.test(href))
      .map((href) => href.startsWith('http') ? href : `https://badnet.fr${href}`);
    const resourceUrls = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((href) => /[?&]drawid=/.test(href) && /[?&]phaseid=/.test(href));
    return links
      .map((el) => {
        const rawUrl = el.getAttribute('data-ic_url') || el.getAttribute('data-url') || el.getAttribute('data-href') || '';
        const embeddedUrl = rawUrl.match(/(?:https?:\/\/[^"']+|\/tournoi\/public\/tableaux[^"']+)/)?.[0] || '';
        return {
          text: (el.textContent || '').trim(),
          dataId: el.getAttribute('data-id') || '',
          elementId: el.id || '',
          href: (el.href || embeddedUrl).replace(/&amp;/g, '&'),
        };
      })
      .filter((item, index, items) => {
        if (items.findIndex((candidate) => candidate.href === item.href && candidate.text === item.text && candidate.dataId === item.dataId && candidate.elementId === item.elementId) !== index) {
          return false;
        }
        return true;
      })
      .filter((item) => item.text || /[?&]drawid=/.test(item.href))
      .concat(htmlUrls.map((href) => ({ text: '', dataId: '', elementId: '', href })))
      .concat(resourceUrls.map((href) => ({ text: '', dataId: '', elementId: '', href })));
  });
  if (drawsData.length === 0) {
    drawsData.push({ text: 'Tableaux', dataId: '', elementId: '' });
  }
  drawsData.unshift({ text: 'Tableaux', dataId: '', elementId: '', href: '' });
  const drawUrls = new Set(
    drawsData
      .map((draw) => canonicalizeTableauxUrl(draw.href))
      .filter(Boolean)
  );
  for (const href of phaseUrls) {
    if (!drawUrls.has(href)) {
      drawUrls.add(href);
      drawsData.push({ text: 'Tableaux', dataId: '', elementId: '', href });
    }
  }

  for (const draw of drawsData) {
    const drawLabel = draw.text;

    if (draw.href && /[?&]drawid=/.test(draw.href) && /[?&]phaseid=/.test(draw.href)) {
      await page.goto(canonicalizeTableauxUrl(draw.href), {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.locator('table').first().waitFor({ state: 'attached', timeout: 1000 }).catch(() => {});
      await parseCurrentTableauxPage(drawLabel || page.url());

      const discoveredPhaseLinks = await page.evaluate(() => {
        const decodeUrl = (rawUrl) => {
          let value = rawUrl;
          if (value.trim().startsWith('{')) {
            try {
              value = JSON.parse(value).url || '';
            } catch {
              value = '';
            }
          }
          return value
          .replace(/&amp;|&#38;|\\u0026/g, '&')
          .replace(/&quot;|&#34;/g, '"')
          .replace(/\\\//g, '/');
        };
        const html = document.documentElement.innerHTML.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
        const values = Array.from(document.querySelectorAll('a, button, [role="tab"], [data-phase-url], [data-ic_url], [data-url], [data-href]'))
          .map((element) => element.href || element.getAttribute('data-phase-url') || element.getAttribute('data-ic_url') || element.getAttribute('data-url') || element.getAttribute('data-href') || '')
          .concat(Array.from(html.matchAll(/(?:https?:\/\/badnet\.fr)?\/tournoi\/public\/tableaux\?[^"'\s<>]+/g)).map((match) => match[0]));
        return values
          .map(decodeUrl)
          .filter((href) => /[?&]drawid=/.test(href) && /[?&]phaseid=/.test(href))
          .map((href) => href.startsWith('http') ? href : `https://badnet.fr${href}`);
      });
      for (const href of discoveredPhaseLinks) {
        collectPhaseUrl(href);
        const normalizedHref = canonicalizeTableauxUrl(href);
        if (normalizedHref && !drawUrls.has(normalizedHref)) {
          drawUrls.add(normalizedHref);
          drawsData.push({ text: '', dataId: '', elementId: '', href });
        }
      }
    }

    // Sélection du tableau
    if (!draw.href) {
      const drawRoot = page;
      const drawLink = draw.dataId
        ? drawRoot.locator(`[data-id="${draw.dataId}"]`).first()
        : draw.elementId
          ? drawRoot.locator(`#${draw.elementId}`).first()
        : drawRoot.locator('a, button, .draw-link').filter({ hasText: drawLabel }).first();
      if ((await drawLink.count()) > 0) {
        const previousDrawUrl = page.url();
        await drawLink.click().catch(() => {});
        await page.waitForURL((url) => url.toString() !== previousDrawUrl, { timeout: 5000 }).catch(() => {});
        await page.locator('button').filter({ hasText: /paires|poules|tableau final/i }).first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});

        const phaseLinks = await page.evaluate(() => {
          const decodeUrl = (rawUrl) => {
            let value = rawUrl;
            if (value.trim().startsWith('{')) {
              try {
                value = JSON.parse(value).url || '';
              } catch {
                value = '';
              }
            }
            return value
              .replace(/&amp;|&#38;|\\u0026/g, '&')
              .replace(/&quot;|&#34;/g, '"');
          };
          const links = Array.from(document.querySelectorAll('a, button, [role="tab"], [data-phaseid], [data-ic_url], [data-url], [data-href]'))
            .map((el) => {
              const rawUrl = el.href || el.getAttribute('data-ic_url') || el.getAttribute('data-url') || el.getAttribute('data-href') || el.getAttribute('data-phase-url') || '';
              return decodeUrl((rawUrl.match(/(?:https?:\/\/[^"']+|\/tournoi\/public\/tableaux[^"']+)/)?.[0] || ''));
            });
          const normalizedHtml = document.documentElement.innerHTML.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
          const embedded = Array.from(normalizedHtml.matchAll(/(?:https?:\/\/badnet\.fr)?\/tournoi\/public\/tableaux\?[^"'\s<>]+/g))
            .map((match) => decodeURIComponent(match[0].replace(/&amp;|&#38;|\\u0026/g, '&').replace(/&quot;|&#34;/g, '"')));
          const phaseAttributes = Array.from(document.querySelectorAll('[data-phase-url]'))
            .map((el) => decodeUrl(el.getAttribute('data-phase-url') || ''));
          return links
            .concat(phaseAttributes)
            .concat(embedded)
            .filter((href) => /[?&]phaseid=/.test(href) && /[?&]drawid=/.test(href))
            .map((href) => href.startsWith('http') ? href : `https://badnet.fr${href}`);
        });
        const phaseControls = page.locator('a, button, [role="tab"]').filter({ hasText: /paires|poules|tableau final|joueurs|tableau principal|consolante/i });
        const phaseControlCount = await phaseControls.count();
        for (let phaseIndex = 0; phaseIndex < phaseControlCount; phaseIndex += 1) {
          const previousPhaseUrl = page.url();
          await phaseControls.nth(phaseIndex).click().catch(() => {});
          await page.waitForURL((url) => url.toString() !== previousPhaseUrl, { timeout: 5000 }).catch(() => {});
          const discovered = await page.evaluate(() => Array.from(document.querySelectorAll('a, button, [data-phase-url], [data-ic_url], [data-url], [data-href]'))
            .map((el) => el.href || el.getAttribute('data-phase-url') || el.getAttribute('data-ic_url') || el.getAttribute('data-url') || el.getAttribute('data-href') || '')
            .filter((href) => /[?&]drawid=/.test(href) && /[?&]phaseid=/.test(href)));
          for (const href of discovered) {
            collectPhaseUrl(href);
          }
        }
        for (const href of phaseLinks) {
          collectPhaseUrl(href);
          const normalizedHref = canonicalizeTableauxUrl(href);
          if (normalizedHref && !drawUrls.has(normalizedHref)) {
            drawUrls.add(normalizedHref);
            drawsData.push({ text: drawLabel, dataId: '', elementId: '', href });
          }
        }
      }
    }

    if (!draw.href || !/[?&]phaseid=/.test(draw.href)) {
      continue;
    }

    for (const href of phaseUrls) {
      if (!drawUrls.has(href)) {
        drawUrls.add(href);
        drawsData.push({ text: 'Tableaux', dataId: '', elementId: '', href });
      }
    }

    const quarterMatches = await page.evaluate(
      ({ targets, label }) => {
        const clean = (raw) => (raw || '').replace(/\baccount_circle\b/gi, '').replace(/\s+/g, ' ').trim();
        const normalize = (raw) =>
          clean(raw)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toUpperCase();

        const root = document.querySelector('#content_draw') || document.body;
        if (!root) {
          return [];
        }

        const out = [];
        const drawDiscipline = Array.from(document.querySelectorAll('h1, h2, h3, h4'))
          .map((heading) => clean(heading.textContent || ''))
          .find((heading) => /^(?:DOUBLE|MIXTE|SIMPLE)\b/i.test(heading)) || label;
        const matchTables = Array.from(root.querySelectorAll('table.matchs, table')).filter((table) => {
          if (!table.classList.contains('matchs')) {
            return false;
          }
          const section = table.closest('section');
          const sectionHeading = normalize(section?.querySelector('h3, h2')?.textContent || '');
          const context = normalize([
            table.parentElement?.textContent || '',
            section?.textContent || '',
          ].join(' '));
          return !/^POULE\b/.test(sectionHeading) && !/\bPOULE\s+(?:[A-Z]|\d+)/.test(context);
        });

        for (const table of matchTables) {
          const rows = Array.from(table.querySelectorAll('tr'));
          for (const row of rows) {
            const playerNodes = Array.from(row.querySelectorAll('.player-infos, p.popup, td'));
            const names = playerNodes.map((node) => clean(node.textContent || '')).filter(Boolean);
            const normalizedNames = names.map((n) => normalize(n));

            for (const target of targets) {
              if (normalizedNames.some((n) => n === target || n.includes(target) || target.includes(n))) {
                out.push({
                  normalizedName: target,
                  status: 'Quart de finale',
                  detail: drawDiscipline,
                });
              }
            }
          }
        }

        const finalPlayerNodes = Array.from(root.querySelectorAll('p, .player-infos, p.popup, td'));
        for (const node of finalPlayerNodes) {
          const nodeName = normalize(node.textContent || '');
          if (!nodeName) {
            continue;
          }

          let current = node;
          let inQuarterFinal = false;
          for (let level = 0; level < 8 && current; level += 1, current = current.parentElement) {
            const headings = Array.from(current.querySelectorAll('h1, h2, h3, h4'))
              .map((heading) => normalize(heading.textContent || ''));
            const context = normalize(current.textContent || '');
            if (headings.some((heading) => /QUART\s+DE\s+FINALE/.test(heading)) && !/\bPOULE\b/.test(context)) {
              inQuarterFinal = true;
              break;
            }
          }
          if (!inQuarterFinal) {
            continue;
          }

          for (const target of targets) {
            if (nodeName === target || nodeName.includes(target) || target.includes(nodeName)) {
              out.push({
                normalizedName: target,
                status: 'Quart de finale',
                detail: drawDiscipline,
              });
            }
          }
        }

        return out;
      },
      { targets: unknownNormalized, label: drawLabel }
    );

    for (const match of quarterMatches) {
      const entry = ensureTableauxEntry(byPlayer, match.normalizedName);
      entry.quarterDraws.add(match.detail);
    }

    const poolMatches = await page.evaluate(
      ({ targets, label }) => {
        const clean = (raw) => (raw || '').replace(/\baccount_circle\b/gi, '').replace(/\s+/g, ' ').trim();
        const normalize = (raw) =>
          clean(raw)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toUpperCase();

        const root = document.querySelector('#content_draw') || document.body;
        if (!root) {
          return [];
        }

        const out = [];
        const tables = Array.from(root.querySelectorAll('table')).filter((table) => {
          if (table.classList.contains('matchs')) {
            return false;
          }

          const headerText = Array.from(table.querySelectorAll('thead th, thead td, tr:first-child th'))
            .map((th) => normalize(th.textContent || ''))
            .join(' | ');
          const tableText = normalize(table.textContent || '');
          const hasName = /NOM PRENOM|JOUEUR|JOUEUSE|PAIRE|PAIRES|NOM/.test(headerText) || /NOM PRENOM|JOUEUR|JOUEUSE|PAIRE|PAIRES/.test(tableText);
          const hasMatchs = /MATCHS|MATCHES/.test(headerText) || /MATCHS|MATCHES/.test(tableText);
          const cltCount = (headerText.match(/\bCLT\b/g) || []).length || (tableText.match(/\bCLT\b/g) || []).length;
          const hasRankedPlayers = table.querySelectorAll('p.popup').length > 0 && Array.from(table.querySelectorAll('tr')).some((row) => {
            const firstCell = normalize(row.querySelector('td')?.textContent || '');
            return /^\s*\d+(?:\s+\d+)?\s*$/.test(firstCell);
          });
          return (hasName && hasMatchs && cltCount > 1) || hasRankedPlayers || table.querySelectorAll('p.popup').length > 0;
        });

        for (const table of tables) {
          const headers = Array.from(table.querySelectorAll('tr th')).map((th) => clean(th.textContent || ''));
          const normalizedHeaders = headers.map((h) => normalize(h));
          const surroundingText = Array.from({ length: 5 }, (_, level) => {
            let node = table;
            for (let step = 0; step < level; step += 1) {
              node = node?.parentElement || null;
            }
            return normalize(node?.textContent || '');
          }).concat(
            Array.from(table.parentElement?.children || [])
              .slice(0, 5)
              .map((node) => normalize(node.textContent || ''))
          ).join(' ');
          const uniquePool = /POULE UNIQUE/.test(surroundingText);

          let nameIndex = normalizedHeaders.findIndex((h) => /JOUEUR|JOUEUSE|PAIRE|PAIRES|NOM/.test(h));
          let winsIndex = normalizedHeaders.findIndex((h) => /MATCHS|MATCHES/.test(h));
          let cltIndex = -1;
          normalizedHeaders.forEach((h, idx) => {
            if (/CLT/.test(h)) {
              cltIndex = idx;
            }
          });

          const bodyRows = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.querySelectorAll('td').length > 0);
          for (const row of bodyRows) {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length === 0) {
              continue;
            }

            const nameCell = nameIndex >= 0 && nameIndex < cells.length
              ? cells[nameIndex]
              : cells.find((cell) => cell.querySelector('p.popup')) || cells[0];
            const popupNames = Array.from(row.querySelectorAll('p.popup'))
              .map((p) => clean(p.textContent || ''))
              .filter(Boolean);
            const candidateNames = popupNames.length > 0 ? popupNames : [clean(nameCell.textContent || '')];
            const candidateKeys = candidateNames.map((n) => normalize(n)).filter(Boolean);
            if (candidateKeys.length === 0) {
              continue;
            }

            for (const target of targets) {
              const matched = candidateKeys.some((rowKey) => rowKey === target || rowKey.includes(target) || target.includes(rowKey));
              if (!matched) {
                continue;
              }

              const winsRaw = winsIndex >= 0 && winsIndex < cells.length
                ? clean(cells[winsIndex].textContent || '')
                : clean(cells[cells.length - 4]?.textContent || '');
              const cltRaw = cltIndex >= 0 && cltIndex < cells.length ? clean(cells[cltIndex].textContent || '') : '';
              const wins = winsRaw;
              const clt = (cltRaw.match(/\d+/) || [''])[0];
              const rankRaw = clean(cells[cells.length - 1]?.textContent || '');
              const rank = Number.parseInt((rankRaw.match(/\d+/) || [''])[0], 10);

              out.push({
                normalizedName: target,
                status: 'Poules',
                detail: clean(table.closest('section')?.querySelector('h3')?.textContent || label),
                wins,
                clt,
                rank: Number.isFinite(rank) ? rank : -1,
                uniquePool,
              });
            }
          }
        }

        if (out.length === 0) {
          const pageText = normalize(root.textContent || '');
          const detail = clean(root.querySelector('h3, h2')?.textContent || label);
          for (const target of targets) {
            const playerFound = Array.from(root.querySelectorAll('p.popup, .player-infos'))
              .some((node) => {
                const name = normalize(node.textContent || '');
                return name === target || name.includes(target) || target.includes(name);
              });
            if (playerFound) {
              out.push({
                normalizedName: target,
                status: 'Poules',
                detail,
                wins: '',
                clt: '',
                rank: -1,
                uniquePool: /POULE UNIQUE/.test(pageText),
              });
            }
          }
        }

        return out;
      },
      { targets: unknownNormalized, label: drawLabel }
    );

    for (const match of poolMatches) {
      const entry = ensureTableauxEntry(byPlayer, match.normalizedName);
      const alreadyExists = entry.poolResults.some(
        (pool) => pool.drawLabel === match.detail && String(pool.wins || '') === String(match.wins || '') && String(pool.clt || '') === String(match.clt || '')
      );
      if (!alreadyExists) {
        const winsValue = Number.parseInt(String(match.wins).match(/\d+/)?.[0] || '', 10);
        const cltValue = Number.parseInt(String(match.clt).match(/\d+/)?.[0] || '', 10);
        entry.poolResults.push({
          drawLabel: match.detail,
          wins: match.wins || '',
          clt: match.clt || '',
          rank: match.rank || -1,
          uniquePool: Boolean(match.uniquePool),
          winsValue: Number.isFinite(winsValue) ? winsValue : -1,
          cltValue: Number.isFinite(cltValue) ? cltValue : 99,
        });
      }
    }

  }

  return byPlayer;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    if (TOURNAMENT_NAME) {
      console.log(`\n=== ${TOURNAMENT_NAME} (eventid=${EVENT_ID}) ===`);
    }

    const response = await page.goto(`https://badnet.fr/tournoi/public/inscriptions?eventid=${EVENT_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 3000,
    });

    assert.ok(response, "Aucune reponse HTTP n'a ete recue.");
    assert.ok(response.ok(), `La page a renvoye un statut HTTP ${response.status()}.`);

    const finalUrl = page.url();
    assert.match(finalUrl, /badnet\.fr\/tournoi\/public\/inscriptions/i, `URL finale inattendue: ${finalUrl}`);

    const title = await page.title();
    assert.ok(title && title.trim().length > 0, 'Le titre de la page est vide.');

    const bodyText = await page.locator('body').innerText();
    assert.ok(bodyText.trim().length > 50, 'Le contenu principal semble vide ou trop court.');

    const searchInput = page
      .locator('input[aria-label="table_players"], input[aria-controls="table_players"]')
      .first();
    await searchInput.waitFor({ state: 'visible', timeout: 1500 });
    const table = page
      .locator('table[aria-controls="table_players"], table[aria-control="table_players"], table#table_players')
      .first();
    await table.waitFor({ state: 'visible', timeout: 1500 });

    const rows = table.locator('tbody tr');
    await rows.first().waitFor({ state: 'attached', timeout: 1500 });

    // Laisse le filtrage JS se stabiliser sans bloquer sur le réseau.
    await page.waitForTimeout(200);

    const inscriptionsData = await rows.evaluateAll((trs) => {
      const clean = (raw) =>
        (raw || '')
          .replace(/\baccount_circle\b/gi, '')
          .replace(/\s*\[[^\]]+\]\s*/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const normalizeDisciplineCell = (raw) =>
        clean(raw)
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toUpperCase();

      const extractPartnerName = (cell) => {
        if (!cell) {
          return '';
        }
        const popup = cell.querySelector('p.popup');
        if (popup) {
          return clean(popup.textContent || '');
        }
        return clean(cell.textContent || '');
      };

      const extractSeriesValues = (row) => Array.from(row.querySelectorAll('td[data-label="Simple"], td[data-label="Double"], td[data-label="Mixte"]'))
        .map((cell) => clean(cell.textContent || ''))
        .filter((value) => /^(SH|SD|SI|DD|DH|DI|MX)\b/i.test(value));

      const extractPair = (cells, disciplinePattern, disciplineLabel) => {
        const disciplineIndex = cells.findIndex((cell) => disciplinePattern.test(normalizeDisciplineCell(cell.textContent || '')));
        if (disciplineIndex < 0) {
          return null;
        }

        const discipline = clean(cells[disciplineIndex].textContent || '');
        const partnerCell = cells[disciplineIndex + 1];
        const partner = partnerCell?.getAttribute('data-label') === 'Partenaire'
          ? extractPartnerName(partnerCell)
          : '';
        return discipline && partner ? { discipline: discipline || disciplineLabel, partner } : null;
      };

      const out = [];
      const clubs = [];
      const pairs = [];
      const disciplines = [];
      for (const tr of trs) {
        if (!(tr instanceof HTMLElement)) {
          continue;
        }

        const cells = Array.from(tr.querySelectorAll('td'));
        if (cells.length === 0) {
          continue;
        }

        const nameCell = tr.querySelector('td[data-label="Nom"]');
        if (!nameCell) {
          continue;
        }

        const clubCell = tr.querySelector('td[data-label="Club"]');

        const popupRawNames = Array.from(nameCell.querySelectorAll('p.popup'))
          .map((p) => (p.textContent || '').trim())
          .filter(Boolean);

        if (popupRawNames.length > 0) {
          const popupNames = popupRawNames.map((name) => clean(name)).filter(Boolean);
          out.push(...popupNames);

          const playerName = popupNames[0] || '';
          if (playerName) {
            clubs.push({ player: playerName, club: clean(clubCell?.textContent || '') });
            disciplines.push({
              player: playerName,
              values: extractSeriesValues(tr),
            });
            const doublePair = extractPair(cells, /\b(DD|DH|DI)\b/, 'Double');
            const mixtePair = extractPair(cells, /\bMX\b/, 'Mixte');
            if (doublePair) {
              pairs.push({ player: playerName, ...doublePair });
            }
            if (mixtePair) {
              pairs.push({ player: playerName, ...mixtePair });
            }
          }

          continue;
        }

        const fallbackRaw = (nameCell.textContent || '').trim();
        if (fallbackRaw) {
          const fallback = clean(fallbackRaw);
          if (fallback) {
            out.push(fallback);
          }

          const playerName = fallback;
          clubs.push({ player: playerName, club: clean(clubCell?.textContent || '') });
          disciplines.push({
            player: playerName,
            values: extractSeriesValues(tr),
          });
          const doublePair = extractPair(cells, /\b(DD|DH|DI)\b/, 'Double');
          const mixtePair = extractPair(cells, /\bMX\b/, 'Mixte');
          if (doublePair) {
            pairs.push({ player: playerName, ...doublePair });
          }
          if (mixtePair) {
            pairs.push({ player: playerName, ...mixtePair });
          }
        }
      }

      return {
        players: out.filter((name) => !/^aucune donnee disponible|no matching records|no data available/i.test(name)),
        clubs,
        disciplines,
        pairs,
      };
    });

    const clubByPlayer = new Map(
      (inscriptionsData.clubs || []).map((entry) => [normalizeForMatch(entry.player), cleanPlayerName(entry.club)])
    );
    const disciplinesByPlayer = new Map();
    for (const entry of inscriptionsData.disciplines || []) {
      const playerKey = normalizeForMatch(entry.player);
      if (!disciplinesByPlayer.has(playerKey)) {
        disciplinesByPlayer.set(playerKey, new Set());
      }
      for (const discipline of entry.values || []) {
        disciplinesByPlayer.get(playerKey).add(cleanPlayerName(discipline));
      }
    }
    const players = Array.from(new Set(inscriptionsData.players)).filter((player) => /BADACHAZ/i.test(clubByPlayer.get(normalizeForMatch(player)) || ''));

    assert.ok(players.length > 0, 'Aucun joueur trouve dans le tableau apres filtrage.');

    const resultsResponse = await page.goto(`https://badnet.fr/tournoi/public/resultats?eventid=${EVENT_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 3000,
    });

    assert.ok(resultsResponse, 'Aucune reponse HTTP pour la page resultats.');
    assert.ok(resultsResponse.ok(), `La page resultats a renvoye un statut HTTP ${resultsResponse.status()}.`);

    await page.locator('div.onglet-datas.onglet-results h2').first().waitFor({ state: 'visible', timeout: 15000 });

    const palmaresEntries = await page.evaluate(() => {
      const normalize = (raw) => (raw || '').replace(/\baccount_circle\b/gi, '').replace(/\s+/g, ' ').trim();
      const rootCandidates = Array.from(document.querySelectorAll('div.onglet-datas.onglet-results'));
      const root = rootCandidates.find((section) => {
        const h2 = section.querySelector('h2');
        return h2 && /palmares de la competition/i.test((h2.textContent || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
      }) || rootCandidates[0];

      if (!root) {
        return [];
      }

      const statusByColumn = {
        1: 'Vainqueurs',
        2: 'Finalistes',
        3: 'Demi-finalistes',
      };

      const entries = [];
      const tables = Array.from(root.querySelectorAll('.b-container-table table'));

      for (const tableEl of tables) {
        const rowsEl = Array.from(tableEl.querySelectorAll('tr'));
        for (const row of rowsEl) {
          if (row.querySelector('th')) {
            continue;
          }

          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 4) {
            continue;
          }

          const discipline = normalize(cells[0].textContent || '');

          for (let col = 1; col <= 3; col += 1) {
            const status = statusByColumn[col];
            if (!status) {
              continue;
            }

            const playerNodes = Array.from(cells[col].querySelectorAll('p.popup.infos'));
            for (const playerNode of playerNodes) {
              const clone = playerNode.cloneNode(true);
              clone.querySelectorAll('.player-infos').forEach((node) => node.remove());
              const name = normalize(clone.textContent || '');
              if (!name) {
                continue;
              }

              entries.push({
                name,
                status,
                discipline,
              });
            }
          }
        }
      }

      return entries;
    });

    assert.ok(palmaresEntries.length > 0, "Aucune entree Palmares n'a ete detectee.");

    const palmaresByPlayer = new Map();
    for (const entry of palmaresEntries) {
      const key = normalizeForMatch(entry.name);
      if (!palmaresByPlayer.has(key)) {
        palmaresByPlayer.set(key, {
          byStatus: new Map(),
          bestStatus: 'Non trouve',
        });
      }

      const playerPalmares = palmaresByPlayer.get(key);
      if (!playerPalmares.byStatus.has(entry.status)) {
        playerPalmares.byStatus.set(entry.status, new Set());
      }
      if (entry.discipline) {
        playerPalmares.byStatus.get(entry.status).add(entry.discipline);
      }

      const currentPriority = STATUS_PRIORITY[playerPalmares.bestStatus] || 0;
      const nextPriority = STATUS_PRIORITY[entry.status] || 0;
      if (nextPriority > currentPriority) {
        playerPalmares.bestStatus = entry.status;
      }
    }

    const tableauxByPlayer = players.length > 0 ? await findUnknownPlayersInTableaux(page, players) : new Map();

    const playerDisciplineResults = new Map();
    const registeredDisciplineForDraw = (playerKey, drawLabel) => {
      const drawSeries = toDrawSeriesKey(drawLabel);
      return Array.from(disciplinesByPlayer.get(playerKey) || [])
        .find((discipline) => toSeriesKey(discipline).startsWith(drawSeries)) || drawLabel;
    };
    const addPlayerResult = (result) => {
      const playerKey = normalizeForMatch(result.player);
      const seriesKey = toSeriesKey(result.discipline || 'Sans discipline');
      const key = `${playerKey}::${seriesKey}`;
      const existing = playerDisciplineResults.get(key);

      const enrichedResult = {
        ...result,
        playerKey,
        seriesKey,
      };

      if (!existing) {
        playerDisciplineResults.set(key, enrichedResult);
        return;
      }

      if (result.isUniquePool) {
        playerDisciplineResults.set(key, enrichedResult);
        return;
      }

      if ((result.priority || 0) > (existing.priority || 0)) {
        playerDisciplineResults.set(key, enrichedResult);
        return;
      }

      if ((result.priority || 0) === STATUS_PRIORITY.Poules && (existing.priority || 0) === STATUS_PRIORITY.Poules) {
        if ((result.sortWins || -1) > (existing.sortWins || -1)) {
          playerDisciplineResults.set(key, enrichedResult);
          return;
        }
        if ((result.sortWins || -1) === (existing.sortWins || -1) && (result.sortClt || 99) < (existing.sortClt || 99)) {
          playerDisciplineResults.set(key, enrichedResult);
        }
      }
    };

    for (const player of players) {
      const playerKey = normalizeForMatch(player);
      const palmares = palmaresByPlayer.get(playerKey);
      if (palmares) {
        for (const [status, disciplinesSet] of palmares.byStatus.entries()) {
          for (const discipline of disciplinesSet) {
            addPlayerResult({
              player: cleanPlayerName(player),
              playerKey,
              status,
              discipline,
              priority: STATUS_PRIORITY[status] || 0,
              sortWins: -1,
              sortClt: 99,
            });
          }
        }
      }

      const tableaux = tableauxByPlayer.get(playerKey);
      if (tableaux) {
        for (const draw of tableaux.quarterDraws) {
          addPlayerResult({
            player: cleanPlayerName(player),
            playerKey,
            status: 'Quart de finale',
            discipline: registeredDisciplineForDraw(playerKey, draw),
            priority: STATUS_PRIORITY['Quart de finale'],
            sortWins: -1,
            sortClt: 99,
          });
        }

        for (const pool of tableaux.poolResults) {
          addPlayerResult({
            player: cleanPlayerName(player),
            playerKey,
            discipline: registeredDisciplineForDraw(playerKey, pool.drawLabel),
            priority: STATUS_PRIORITY[pool.uniquePool && pool.rank === 2 ? '2ième' : pool.uniquePool && pool.rank === 3 ? '3ieme' : 'Poules'],
            sortWins: pool.winsValue,
            sortClt: pool.cltValue,
            wins: pool.wins,
            clt: pool.clt,
            status: pool.uniquePool && pool.rank === 2 ? '2ième' : pool.uniquePool && pool.rank === 3 ? '3ieme' : 'Poules',
            isUniquePool: pool.uniquePool,
            isPoolResult: true,
            rank: pool.rank,
          });
        }
      }
    }

    for (const player of players) {
      const playerKey = normalizeForMatch(player);
      for (const discipline of disciplinesByPlayer.get(playerKey) || []) {
        const resultKey = `${playerKey}::${toSeriesKey(discipline)}`;
        if (!playerDisciplineResults.has(resultKey)) {
          addPlayerResult({
            player: cleanPlayerName(player),
            status: 'Non trouve',
            discipline,
            priority: STATUS_PRIORITY['Non trouve'],
            sortWins: -1,
            sortClt: 99,
          });
        }
      }
    }

    const partnerByPlayerDiscipline = new Map();
    for (const pair of inscriptionsData.pairs || []) {
      const p1 = normalizeForMatch(pair.player);
      const p2 = normalizeForMatch(pair.partner);
      const seriesKey = toSeriesKey(pair.discipline);
      if (!p1 || !p2 || !seriesKey) {
        continue;
      }
      partnerByPlayerDiscipline.set(`${p1}::${seriesKey}`, {
        name: cleanPlayerName(pair.partner),
        club: clubByPlayer.get(p2) || '',
      });
      partnerByPlayerDiscipline.set(`${p2}::${seriesKey}`, {
        name: cleanPlayerName(pair.player),
        club: clubByPlayer.get(p1) || '',
      });
    }

    const formatPairMember = (name, club) => /BADACHAZ/i.test(club || '') || !club ? cleanPlayerName(name) : `${cleanPlayerName(name)} (${club})`;

    const groupedSummary = [];
    const consumed = new Set();
    const representedMissing = new Set();
    for (const result of playerDisciplineResults.values()) {
      const resultKey = `${result.playerKey}::${result.seriesKey}`;
      if (consumed.has(resultKey)) {
        continue;
      }

      const isDoubleDiscipline = /^(DD|DH|DI|MX)\b/i.test(result.seriesKey || '');
      const partner = partnerByPlayerDiscipline.get(resultKey);
      const partnerName = partner?.name || '';
      const partnerKey = partnerName ? normalizeForMatch(partnerName) : '';
      const partnerResultKey = partnerKey ? `${partnerKey}::${result.seriesKey}` : '';
      const partnerResult = partnerResultKey ? playerDisciplineResults.get(partnerResultKey) : null;

      if (isDoubleDiscipline && partnerName) {
        const pairMembers = [
          formatPairMember(result.player, clubByPlayer.get(result.playerKey) || ''),
          formatPairMember(partnerResult?.player || partnerName, partner.club),
        ].sort((a, b) => a.localeCompare(b, 'fr'));
        const groupedResult = partnerResult && partnerResult.priority > result.priority ? partnerResult : result;
        groupedSummary.push({
          label: `${pairMembers[0]} et ${pairMembers[1]}`,
          status: groupedResult.status,
          discipline: groupedResult.discipline,
          priority: groupedResult.priority,
          sortWins: groupedResult.sortWins || -1,
          sortClt: groupedResult.sortClt || 99,
          wins: groupedResult.wins || '',
          clt: groupedResult.clt || '',
          rank: groupedResult.rank,
          isUniquePool: groupedResult.isUniquePool,
          isPoolResult: groupedResult.isPoolResult,
        });
        consumed.add(resultKey);
        if (partnerResult) {
          consumed.add(partnerResultKey);
        } else {
          representedMissing.add(partnerKey);
        }
        continue;
      }

      groupedSummary.push({
        label: cleanPlayerName(result.player),
        status: result.status,
        discipline: result.discipline,
        priority: result.priority,
        sortWins: result.sortWins || -1,
        sortClt: result.sortClt || 99,
        wins: result.wins || '',
        clt: result.clt || '',
        rank: result.rank,
        isUniquePool: result.isUniquePool,
        isPoolResult: result.isPoolResult,
      });
      consumed.add(resultKey);
    }

    const playersWithoutResult = players
      .map((player) => ({ player, key: normalizeForMatch(player) }))
      .filter(({ key }) => !Array.from(playerDisciplineResults.values()).some((r) => r.playerKey === key) && !representedMissing.has(key));
    const missingByKey = new Map(playersWithoutResult.map((missing) => [missing.key, missing]));
    const consumedMissing = new Set();

    for (const missing of playersWithoutResult) {
      if (consumedMissing.has(missing.key)) {
        continue;
      }

      const missingPair = (inscriptionsData.pairs || []).find((candidate) => {
        return normalizeForMatch(candidate.player) === missing.key && /^(DD|DH|DI|MX)\b/i.test(toSeriesKey(candidate.discipline));
      });
      if (missingPair) {
        const pairMembers = [
          formatPairMember(missingPair.player, clubByPlayer.get(normalizeForMatch(missingPair.player)) || ''),
          formatPairMember(missingPair.partner, clubByPlayer.get(normalizeForMatch(missingPair.partner)) || ''),
        ].sort((a, b) => a.localeCompare(b, 'fr'));
        groupedSummary.push({
          label: `${pairMembers[0]} et ${pairMembers[1]}`,
          status: 'Non trouve',
          discipline: missingPair.discipline,
          priority: STATUS_PRIORITY['Non trouve'],
          sortWins: -1,
          sortClt: 99,
          wins: '',
          clt: '',
        });
        consumedMissing.add(missing.key);
        continue;
      }

      const pair = (inscriptionsData.pairs || []).find((candidate) => {
        const playerKey = normalizeForMatch(candidate.player);
        const partnerKey = normalizeForMatch(candidate.partner);
        return playerKey === missing.key && missingByKey.has(partnerKey) || partnerKey === missing.key && missingByKey.has(playerKey);
      });

      if (pair) {
        const pairPlayer = missingByKey.get(normalizeForMatch(pair.player));
        const pairPartner = missingByKey.get(normalizeForMatch(pair.partner));
        if (pairPlayer && pairPartner) {
          const names = [cleanPlayerName(pairPlayer.player), cleanPlayerName(pairPartner.player)].sort((a, b) => a.localeCompare(b, 'fr'));
          groupedSummary.push({
            label: `${names[0]} et ${names[1]}`,
            status: 'Non trouve',
            discipline: pair.discipline,
            priority: STATUS_PRIORITY['Non trouve'],
            sortWins: -1,
            sortClt: 99,
            wins: '',
            clt: '',
          });
          consumedMissing.add(pairPlayer.key);
          consumedMissing.add(pairPartner.key);
          continue;
        }
      }

      groupedSummary.push({
        label: cleanPlayerName(missing.player),
        status: 'Non trouve',
        discipline: '',
        priority: STATUS_PRIORITY['Non trouve'],
        sortWins: -1,
        sortClt: 99,
        wins: '',
        clt: '',
      });
    }

    groupedSummary.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      if (a.isPoolResult && b.isPoolResult) {
        if (b.sortWins !== a.sortWins) {
          return b.sortWins - a.sortWins;
        }
        if (a.sortClt !== b.sortClt) {
          return a.sortClt - b.sortClt;
        }
      }
      const disciplineCmp = (a.discipline || '').localeCompare(b.discipline || '', 'fr');
      if (disciplineCmp !== 0) {
        return disciplineCmp;
      }
      return a.label.localeCompare(b.label, 'fr');
    });

    const statusLabels = {
      Vainqueurs: 'Vainqueur',
      Finalistes: 'Finaliste',
      'Demi-finalistes': 'Demi-finaliste',
      'Quart de finale': 'Quart de finale',
      '2ième': '2ième',
      '3ieme': '3ieme',
      Poules: 'Poules',
      'Non trouve': 'Non trouve',
    };
    const formatPoolStatus = (line) => {
      const rankText = line.rank > 0 ? `${line.rank}ieme de la poule${line.isUniquePool ? ' unique' : ''}` : `Poule${line.isUniquePool ? ' unique' : ''}`;
      const winsValue = Number.parseInt(String(line.wins || '').match(/\d+/)?.[0] || '', 10);
      const winsText = Number.isFinite(winsValue)
        ? `avec ${winsValue} victoire${winsValue === 1 ? '' : 's'}`
        : 'avec un nombre de victoires inconnu';
      return `${rankText} ${winsText}`;
    };
    const categoryByKey = new Map();
    for (const line of groupedSummary) {
      const category = cleanPlayerName(line.discipline || 'Sans discipline').replace(/\s*\([^)]*\)/g, '').trim();
      const categoryKey = normalizeForMatch(category);
      if (!categoryByKey.has(categoryKey)) {
        categoryByKey.set(categoryKey, { label: category, lines: [] });
      }
      categoryByKey.get(categoryKey).lines.push(line);
    }

    console.log('Joueurs trouves pour "badachaz" + resultat Palmares:');
    for (const category of Array.from(categoryByKey.values()).sort((a, b) => a.label.localeCompare(b.label, 'fr'))) {
      console.log(`${category.label} :`);
      for (const line of category.lines) {
        const status = statusLabels[line.status] || line.status;
        if (line.isPoolResult) {
          console.log(`- ${line.label} : ${formatPoolStatus(line)}`);
          continue;
        }
        console.log(`- ${line.label} : ${status}`);
      }
    }
  } catch (error) {
    console.error('Extraction du tournoi échouée.');
    throw error;
  } finally {
    await browser.close();
  }
})();