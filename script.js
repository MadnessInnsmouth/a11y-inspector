// =====================================
// 1. DOM Elements
// =====================================
const urlInput = document.getElementById('url-input');
const htmlInput = document.getElementById('html-input');
const runAuditBtn = document.getElementById('run-audit-btn');
const loadingIndicator = document.getElementById('loading-indicator');
const auditSummary = document.getElementById('audit-summary');
const violationCountSpan = document.getElementById('violation-count');
const impactBreakdownList = document.getElementById('impact-breakdown');
const violationsList = document.getElementById('violations-list');
const noViolationsMessage = document.getElementById('no-violations-message');
const auditHistoryList = document.getElementById('audit-history-list');
const historyActions = document.getElementById('history-actions');
const exportJsonBtn = document.getElementById('export-json-btn');
const exportCsvBtn = document.getElementById('export-csv-btn');
const clearHistoryBtn = document.getElementById('clear-history-btn');

// =====================================
// 2. Configuration
// =====================================
// IMPORTANT: For fetching external URLs due to CORS, you will likely need a proxy.
// Replace this with the URL of your own CORS proxy.
// Examples of how to set up a simple CORS proxy can be found online (e.g., using Node.js, PHP, or Cloudflare Workers).
// A public one like https://cors-anywhere.herokuapp.com/ is NOT recommended for production
// due to rate limits and reliability.
const CORS_PROXY_URL = 'https://your-cors-proxy.com/'; // <-- REPLACE THIS WITH YOUR OWN PROXY URL
const AXE_CORE_CDN = 'https://cdn.jsdelivr.net/npm/axe-core@4.9.1/axe.min.js'; // Using a stable CDN version

const DB_NAME = 'A11yAuditDB';
const DB_VERSION = 1;
const STORE_NAME = 'audits';

let db; // IndexedDB instance

// =====================================
// 3. UI Utility Functions
// =====================================
function showLoading() {
    loadingIndicator.classList.remove('hidden');
    runAuditBtn.disabled = true;
    runAuditBtn.textContent = 'Running Audit...';
    auditSummary.classList.add('hidden'); // Hide summary while loading
    violationsList.innerHTML = ''; // Clear previous violations
    noViolationsMessage.classList.add('hidden');
    auditSummary.setAttribute('aria-live', 'off'); // Temporarily turn off live region
}

function hideLoading() {
    loadingIndicator.classList.add('hidden');
    runAuditBtn.disabled = false;
    runAuditBtn.textContent = 'Run Audit';
    auditSummary.setAttribute('aria-live', 'polite'); // Re-enable live region for results
}

function clearResultsUI() {
    violationCountSpan.textContent = '0';
    impactBreakdownList.innerHTML = '';
    violationsList.innerHTML = '';
    noViolationsMessage.classList.add('hidden');
    auditSummary.classList.add('hidden');
}

function displayResultsUI(results) {
    auditSummary.classList.remove('hidden');

    const violations = results.violations;
    violationCountSpan.textContent = violations.length;

    if (violations.length === 0) {
        noViolationsMessage.classList.remove('hidden');
        auditSummary.focus(); // Announce no violations to screen reader
        return;
    }

    noViolationsMessage.classList.add('hidden');

    // Populate Impact Breakdown
    const impactCounts = {};
    violations.forEach(violation => {
        impactCounts[violation.impact] = (impactCounts[violation.impact] || 0) + 1;
    });

    impactBreakdownList.innerHTML = '';
    const sortedImpacts = Object.keys(impactCounts).sort((a, b) => {
        const impactOrder = { 'critical': 1, 'serious': 2, 'moderate': 3, 'minor': 4 };
        return impactOrder[a] - impactOrder[b];
    });

    sortedImpacts.forEach(impact => {
        const li = document.createElement('li');
        li.className = `impact-${impact}`;
        li.textContent = `${impact.charAt(0).toUpperCase() + impact.slice(1)}: ${impactCounts[impact]}`;
        impactBreakdownList.appendChild(li);
    });

    // Populate Violations List
    violationsList.innerHTML = '';
    violations.forEach((violation, index) => {
        violationsList.appendChild(renderViolationItem(violation, index));
    });

    // Announce results to screen readers
    auditSummary.focus(); // Shift focus to summary
    // Optionally: Use aria-live with an element that gets updated or use a separate SR-only element
    // For now, focus + aria-live on parent section should work reasonably well.
}

function renderViolationItem(violation, index) {
    const violationItem = document.createElement('div');
    violationItem.className = 'violation-item';
    violationItem.setAttribute('role', 'group');
    violationItem.setAttribute('aria-labelledby', `violation-${index}-title`);

    const titleId = `violation-${index}-title`;
    const detailsId = `violation-${index}-details`;

    violationItem.innerHTML = `
        <h3 id="${titleId}">${violation.help}</h3>
        <p><strong>Impact:</strong> <span class="impact-${violation.impact}">${violation.impact.charAt(0).toUpperCase() + violation.impact.slice(1)}</span></p>
        <p><strong>Description:</strong> ${violation.helpUrl ? `<a href="${violation.helpUrl}" target="_blank" rel="noopener noreferrer">${violation.description}</a>` : violation.description}</p>
        <button class="expand-btn" aria-expanded="false" aria-controls="${detailsId}" aria-label="Expand details for ${violation.help}"></button>
        <div id="${detailsId}" class="violation-details">
            <p><strong>WCAG Tags:</strong> ${violation.tags.filter(tag => tag.startsWith('wcag')).map(tag => tag.toUpperCase()).join(', ')}</p>
            <p><strong>Remediation:</strong> ${violation.html || violation.nodes.length > 0 ? violation.nodes[0]?.failureSummary || 'No specific remediation tip available from axe-core for this instance.' : 'No remediation tip available.'}</p>
            ${violation.nodes.length > 0 ? `
                <p><strong>Elements violated:</strong></p>
                <ul>
                    ${violation.nodes.map(node => `<li><code>${node.html}</code></li>`).join('')}
                </ul>
            ` : ''}
        </div>
    `;
    return violationItem;
}

// =====================================
// 4. IndexedDB Setup
// =====================================
function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            resolve(db);
        };

        request.onerror = (event) => {
            console.error('IndexedDB error:', event.target.errorCode);
            reject(event.target.error);
        };
    });
}

async function saveAuditResult(url, timestamp, violationsCount, resultsData) {
    if (!db) await openDb();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const audit = { url, timestamp, violationsCount, results: resultsData };
        const request = store.add(audit);

        request.onsuccess = () => {
            resolve(audit);
        };

        request.onerror = (event) => {
            console.error('Error saving audit:', event.target.error);
            reject(event.target.error);
        };
    });
}

async function getAuditHistory() {
    if (!db) await openDb();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = (event) => {
            // Sort by timestamp descending (newest first)
            const history = event.target.result.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            resolve(history);
        };

        request.onerror = (event) => {
            console.error('Error getting audit history:', event.target.error);
            reject(event.target.error);
        };
    });
}

async function clearAllAudits() {
    if (!db) await openDb();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();

        request.onsuccess = () => {
            console.log('All audits cleared.');
            resolve();
        };

        request.onerror = (event) => {
            console.error('Error clearing audits:', event.target.error);
            reject(event.target.error);
        };
    });
}


// =====================================
// 5. Audit Logic
// =====================================

/**
 * Fetches HTML content from a given URL, using a CORS proxy if necessary.
 * @param {string} url The URL to fetch.
 * @returns {Promise<string>} The HTML content as a string.
 */
async function fetchPageContent(url) {
    try {
        const proxyUrl = `${CORS_PROXY_URL}${url}`;
        const response = await fetch(proxyUrl);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.text();
    } catch (error) {
        console.error('Error fetching page content:', error);
        throw new Error('Failed to fetch page. Please check the URL and CORS proxy configuration.');
    }
}

/**
 * Runs axe-core audit on the given HTML content within an isolated iframe.
 * @param {string} htmlContent The HTML content to audit.
 * @returns {Promise<object>} The axe-core results.
 */
async function runAxeAudit(htmlContent) {
    return new Promise((resolve, reject) => {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        // Using `srcdoc` for direct HTML injection.
        // For large HTML, consider creating a Blob URL for `src`
        // or a data URI if supported well and size permits.
        // `srcdoc` is generally safe and works well.
        iframe.srcdoc = htmlContent;
        document.body.appendChild(iframe);

        iframe.onload = async () => {
            try {
                // Inject axe-core into the iframe's contentWindow
                const script = iframe.contentWindow.document.createElement('script');
                script.src = AXE_CORE_CDN;
                script.onload = async () => {
                    if (iframe.contentWindow.axe) {
                        const results = await iframe.contentWindow.axe.run(iframe.contentWindow.document);
                        document.body.removeChild(iframe); // Clean up iframe
                        resolve(results);
                    } else {
                        document.body.removeChild(iframe);
                        reject(new Error('axe-core not loaded in iframe.'));
                    }
                };
                script.onerror = (e) => {
                    document.body.removeChild(iframe);
                    reject(new Error(`Failed to load axe-core in iframe: ${e.message}`));
                };
                iframe.contentWindow.document.head.appendChild(script);

            } catch (error) {
                document.body.removeChild(iframe);
                reject(new Error(`Error during axe-core injection/run: ${error.message}`));
            }
        };

        iframe.onerror = (e) => {
            document.body.removeChild(iframe);
            reject(new Error(`Iframe loading error: ${e.message}`));
        };
    });
}


// =====================================
// 6. History Display & Export
// =====================================
async function loadAuditHistory() {
    const history = await getAuditHistory();
    auditHistoryList.innerHTML = ''; // Clear current list

    if (history.length === 0) {
        auditHistoryList.innerHTML = '<li class="no-history-message">No past audits yet.</li>';
        historyActions.classList.add('hidden');
    } else {
        historyActions.classList.remove('hidden');
        history.forEach(audit => {
            auditHistoryList.appendChild(renderHistoryItem(audit));
        });
    }
}

function renderHistoryItem(audit) {
    const historyItem = document.createElement('li');
    historyItem.setAttribute('data-id', audit.id); // Store ID for potential future actions
    historyItem.innerHTML = `
        <span><strong>${audit.url || 'Pasted HTML'}</strong> - ${audit.timestamp}</span>
        <span>Violations: ${audit.violationsCount}</span>
    `;
    // For now, no click action on history item, but could add "View Details"
    return historyItem;
}

function exportData(format) {
    getAuditHistory().then(history => {
        if (history.length === 0) {
            alert('No audit history to export.');
            return;
        }

        let data, filename, mimeType;

        if (format === 'json') {
            data = JSON.stringify(history, null, 2);
            filename = 'a11y-audit-history.json';
            mimeType = 'application/json';
        } else if (format === 'csv') {
            // Flatten the data for CSV
            const csvRows = [];
            const headers = ['ID', 'URL', 'Timestamp', 'Violations Count', 'Violation Help', 'Violation Description', 'Violation Impact', 'WCAG Tags', 'Remediation', 'HTML Node'];
            csvRows.push(headers.join(','));

            history.forEach(audit => {
                if (audit.results && audit.results.violations && audit.results.violations.length > 0) {
                    audit.results.violations.forEach(violation => {
                        const row = [
                            audit.id,
                            `"${audit.url || 'Pasted HTML'}"`, // Quote URL in case of commas
                            `"${audit.timestamp}"`,
                            audit.violationsCount,
                            `"${violation.help.replace(/"/g, '""')}"`, // Escape quotes
                            `"${violation.description.replace(/"/g, '""')}"`,
                            violation.impact,
                            `"${violation.tags.filter(tag => tag.startsWith('wcag')).map(tag => tag.toUpperCase()).join('; ').replace(/"/g, '""')}"`,
                            `"${(violation.nodes[0]?.failureSummary || 'N/A').replace(/"/g, '""')}"`,
                            `"${(violation.nodes.map(n => n.html).join('; ') || 'N/A').replace(/"/g, '""')}"`
                        ];
                        csvRows.push(row.join(','));
                    });
                } else {
                    // Add a row for audits with no violations
                    const row = [
                        audit.id,
                        `"${audit.url || 'Pasted HTML'}"`,
                        `"${audit.timestamp}"`,
                        audit.violationsCount,
                        'N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A'
                    ];
                    csvRows.push(row.join(','));
                }
            });

            data = csvRows.join('\n');
            filename = 'a11y-audit-history.csv';
            mimeType = 'text/csv';
        }

        const blob = new Blob([data], { type: mimeType });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href); // Clean up URL object
    }).catch(error => {
        console.error('Export failed:', error);
        alert('Failed to export history. See console for details.');
    });
}


// =====================================
// 7. Event Listeners
// =====================================
runAuditBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    const html = htmlInput.value.trim();

    if (!url && !html) {
        alert('Please enter a URL or paste HTML to audit.');
        return;
    }

    if (url && html) {
        alert('Please enter EITHER a URL OR paste HTML, not both.');
        return;
    }

    showLoading();
    clearResultsUI();

    let targetHtml = html;
    let auditSource = url || 'Pasted HTML';
    let auditResults = null;

    try {
        if (url) {
            targetHtml = await fetchPageContent(url);
        }
        
        auditResults = await runAxeAudit(targetHtml);
        displayResultsUI(auditResults);

        const timestamp = new Date().toLocaleString();
        await saveAuditResult(auditSource, timestamp, auditResults.violations.length, auditResults);
        await loadAuditHistory(); // Refresh history list

    } catch (error) {
        console.error('Audit failed:', error);
        alert(`Audit failed: ${error.message || 'An unknown error occurred.'}`);
        clearResultsUI();
    } finally {
        hideLoading();
    }
});

violationsList.addEventListener('click', (event) => {
    const target = event.target;
    if (target.classList.contains('expand-btn')) {
        const violationItem = target.closest('.violation-item');
        const details = violationItem.querySelector('.violation-details');
        if (details) {
            const isExpanded = violationItem.classList.toggle('expanded');
            details.style.display = isExpanded ? 'block' : 'none';
            target.setAttribute('aria-expanded', isExpanded);
            target.setAttribute('aria-label', isExpanded ? `Collapse details for ${violationItem.querySelector('h3').textContent}` : `Expand details for ${violationItem.querySelector('h3').textContent}`);
        }
    }
});

exportJsonBtn.addEventListener('click', () => exportData('json'));
exportCsvBtn.addEventListener('click', () => exportData('csv'));

clearHistoryBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all audit history? This action cannot be undone.')) {
        try {
            await clearAllAudits();
            await loadAuditHistory(); // Reload history, will show 'no history' message
        } catch (error) {
            console.error('Error clearing history:', error);
            alert('Failed to clear history. See console for details.');
        }
    }
});

// =====================================
// 8. PWA Service Worker Registration
// =====================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js')
            .then(registration => {
                console.log('Service Worker registered with scope:', registration.scope);
            })
            .catch(error => {
                console.error('Service Worker registration failed:', error);
            });
    });
}

// =====================================
// 9. Initial Load Logic
// =====================================
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await openDb();
        await loadAuditHistory();
    } catch (error) {
        console.error('Failed to initialize application:', error);
        alert('There was an issue initializing the app (e.g., IndexedDB). Please try again.');
    }
});
