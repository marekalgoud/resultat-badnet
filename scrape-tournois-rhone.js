const { execFileSync } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const DEPARTMENT = 'Comité Départemental 69 - Rhône';
const RESULTS_SCRIPT = path.join(__dirname, 'scrapping-badnet.js');

async function waitForResultsRefresh(page) {
  let sawLoading = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt === 0) {
      await page.waitForTimeout(300);
    }
    const loading = page.getByText(/chargement/i);
    const count = await loading.count();
    const visible = [];
    for (let index = 0; index < count; index += 1) {
      if (await loading.nth(index).isVisible().catch(() => false)) {
        visible.push(loading.nth(index));
      }
    }
    if (visible.length === 0) {
      if (!sawLoading) {
        await page.waitForTimeout(500);
      } else {
        break;
      }
      continue;
    }
    sawLoading = true;
    await Promise.all(visible.map((indicator) => indicator.waitFor({ state: 'hidden', timeout: 30000 })));
  }
  await page.waitForTimeout(250);
}

async function readActiveFilters(page) {
  return page.evaluate(() => {
    const department = document.querySelector('#departement');
    const dateInput = document.querySelector('#date');
    const dates = dateInput?._flatpickr?.selectedDates || [];
    const formatDate = (date) => {
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${date.getFullYear()}-${month}-${day}`;
    };
    return {
      department: department?.value,
      dates: dates.map(formatDate),
    };
  });
}

function formatDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function getPreviousWeekRange() {
  const today = new Date();
  const day = today.getDay() || 7;
  const end = new Date(today);
  end.setHours(0, 0, 0, 0);
  end.setDate(today.getDate() - day);
  const start = new Date(end);
  start.setDate(end.getDate() - 6);
  return {
    start: formatDate(start),
    end: formatDate(end),
  };
}

async function selectDepartment(page) {
  const selects = page.locator('select');
  const count = await selects.count();
  for (let index = 0; index < count; index += 1) {
    const select = selects.nth(index);
    const departmentValue = await select.locator('option').evaluateAll((options, department) =>
      options.find((option) => option.textContent.trim() === department)?.value,
    DEPARTMENT);
    if (departmentValue === undefined) {
      continue;
    }

    const selectId = await select.getAttribute('id');
    const visibleSelection = selectId
      ? page.locator(`#select2-${selectId}-container`)
      : page.locator('.select2-selection__rendered').filter({ hasText: DEPARTMENT });
    if (await visibleSelection.count()) {
      await visibleSelection.click();
      const option = page.getByRole('option', { name: DEPARTMENT, exact: true });
      await option.waitFor({ state: 'visible', timeout: 5000 });
      await option.click();
    } else {
      await select.selectOption({ value: departmentValue });
    }
    const selectedValue = await select.inputValue();
    return selectedValue === departmentValue;
  }
  return false;
}

async function fillDateFields(page, start, end) {
  const flatpickrInput = page.locator('#date');
  if (await flatpickrInput.count()) {
    const updated = await flatpickrInput.evaluate((element, range) => {
      if (!element._flatpickr) {
        return false;
      }
      element._flatpickr.setDate([range.start, range.end], true);
      return true;
    }, { start, end });
    if (updated) {
      return true;
    }
  }

  const dateInputs = page.locator('input[type="date"]');
  if (await dateInputs.count() >= 2) {
    await dateInputs.nth(0).fill(start);
    await dateInputs.nth(1).fill(end);
    return true;
  }

  const candidates = page.locator('input');
  const count = await candidates.count();
  const dateLike = [];
  for (let index = 0; index < count; index += 1) {
    const input = candidates.nth(index);
    const metadata = await input.evaluate((element) => [
      element.name,
      element.id,
      element.placeholder,
      element.getAttribute('aria-label'),
    ].join(' ').toLowerCase());
    if (/date|debut|début|fin|from|to/.test(metadata)) {
      dateLike.push(input);
    }
  }
  if (dateLike.length >= 2) {
    await dateLike[0].fill(start);
    await dateLike[1].fill(end);
    return true;
  }
  return false;
}

async function collectTournaments(page) {
  return page.evaluate(() => {
    const events = new Map();
    for (const link of Array.from(document.querySelectorAll('a[href*="eventid="]'))) {
      try {
        const url = new URL(link.href, location.href);
        const eventId = url.searchParams.get('eventid');
        if (!eventId || events.has(eventId)) {
          continue;
        }
        const text = (link.closest('article, li, .card, .competition, .tournoi') || link).textContent
          .replace(/\s+/g, ' ')
          .trim();
        const name = text.split(/\s*\|\s*(?:Dim|Lun|Mar|Mer|Jeu|Ven|Sam)\b/i)[0].trim()
          || text.split(/\s+Le\s+\d{1,2}\s+/i)[0].trim()
          || `Tournoi ${eventId}`;
        events.set(eventId, {
          eventId,
          name,
        });
      } catch {
        // Ignore les liens non exploitables.
      }
    }
    return Array.from(events.values());
  });
}

async function main() {
  const defaults = getPreviousWeekRange();
  const start = process.env.START_DATE || defaults.start;
  const end = process.env.END_DATE || defaults.end;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('https://badnet.fr/accueil', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('button', { name: 'Refuser' }).click().catch(() => {});
    await page.locator('li').filter({ hasText: /^Tournois$/i }).click().catch(() => {});
    await page.locator('select, input').first().waitFor({ state: 'attached', timeout: 10000 });
    await waitForResultsRefresh(page);

    if (!await selectDepartment(page)) {
      throw new Error(`Département introuvable: ${DEPARTMENT}`);
    }
    await waitForResultsRefresh(page);
    const departmentFilter = await readActiveFilters(page);
    if (departmentFilter.department !== '112') {
      throw new Error(`BadNet a réinitialisé le département: ${JSON.stringify(departmentFilter)}`);
    }
    if (!await fillDateFields(page, start, end)) {
      throw new Error('Champs de date introuvables sur la page BadNet.');
    }
    await waitForResultsRefresh(page);
    const activeFilters = await readActiveFilters(page);
    if (activeFilters.department !== '112' || activeFilters.dates.join(',') !== `${start},${end}`) {
      throw new Error(`BadNet a réinitialisé les filtres: ${JSON.stringify(activeFilters)}`);
    }

    const searchButton = page.getByRole('button', { name: /rechercher|filtrer|valider/i }).first();
    if (await searchButton.count()) {
      await searchButton.click();
    }
    const tournaments = await collectTournaments(page);
    console.log(`Tournois du Rhône du ${start} au ${end}: ${tournaments.length}`);
    let extractionFailures = 0;
    for (const tournament of tournaments) {
      try {
        execFileSync(process.execPath, [RESULTS_SCRIPT], {
          cwd: __dirname,
          env: {
            ...process.env,
            EVENT_ID: tournament.eventId,
            TOURNAMENT_NAME: tournament.name,
          },
          stdio: 'inherit',
        });
      } catch (error) {
        extractionFailures += 1;
        console.error(`Extraction échouée pour ${tournament.name} (${tournament.eventId}).`);
      }
    }
    if (extractionFailures > 0) {
      throw new Error(`${extractionFailures} extraction(s) de tournoi ont échoué.`);
    }
  } catch (error) {
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});