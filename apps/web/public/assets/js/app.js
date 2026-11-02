import { getCatalogPage, getSystemStatus, getOpenActionUrl, resolveApiAssetUrl } from './api.js';

const elements = {
  themeToggle: document.querySelector('#theme-toggle'),
  apiIndicator: document.querySelector('#api-indicator'),
  apiState: document.querySelector('#api-state'),
  operationMode: document.querySelector('#operation-mode'),
  search: document.querySelector('#catalog-search'),
  resultCount: document.querySelector('#result-count'),
  lastScan: document.querySelector('#last-scan'),
  grid: document.querySelector('#catalog-grid'),
  emptyState: document.querySelector('#empty-state'),
  emptyEyebrow: document.querySelector('#empty-eyebrow'),
  emptyTitle: document.querySelector('#empty-title'),
  emptyDescription: document.querySelector('#empty-description'),
  feedback: document.querySelector('#catalog-feedback'),
  loadMore: document.querySelector('#load-more'),
  viewGrid: document.querySelector('#view-grid'),
  viewList: document.querySelector('#view-list'),
  stored: document.querySelector('#metric-stored'),
  clicked: document.querySelector('#metric-clicked'),
  unopened: document.querySelector('#metric-unopened'),
  authText: document.querySelector('#authorization-text'),
  authStatus: document.querySelector('#authorization-status'),
};

const state = {
  query: '',
  cursor: null,
  hasMore: false,
  loadedCount: 0,
  loadedQuery: null,
  searchController: null,
  searchTimer: null,
  view: 'grid',
};

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('ero-scrap-theme', theme); } catch { /* Storage can be unavailable. */ }
}

function initializeTheme() {
  let savedTheme = null;
  try { savedTheme = localStorage.getItem('ero-scrap-theme'); } catch { /* Ignore unavailable storage. */ }
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  setTheme(savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : (prefersDark ? 'dark' : 'light'));
}

function setApiState(label, status) {
  elements.apiState.textContent = label;
  elements.apiIndicator.classList.remove('is-online', 'is-error');
  if (status === 'online') elements.apiIndicator.classList.add('is-online');
  if (status === 'error') elements.apiIndicator.classList.add('is-error');
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatDuration(durationMs) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return 'Duração indisponível';
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function createVideoCard(item) {
  const article = document.createElement('article');
  article.className = 'video-card';
  article.dataset.id = item.id;

  const thumbnail = document.createElement('div');
  thumbnail.className = 'video-thumbnail';
  if (typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.startsWith('/api/thumbnails/')) {
    const image = document.createElement('img');
    image.src = resolveApiAssetUrl(item.thumbnailUrl) || '';
    if (!image.src) {
      thumbnail.textContent = 'Prévia indisponível';
    } else {
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.width = 320;
      image.height = 180;
      image.addEventListener('error', () => {
        image.remove();
        thumbnail.textContent = 'Prévia indisponível';
      }, { once: true });
      thumbnail.append(image);
    }
  } else {
    thumbnail.setAttribute('aria-hidden', 'true');
    thumbnail.textContent = 'Prévia indisponível';
  }

  const details = document.createElement('div');
  details.className = 'video-details';

  const title = document.createElement('h3');
  title.textContent = item.title || 'Publicação sem título';

  const metadata = document.createElement('p');
  metadata.className = 'video-metadata';
  metadata.textContent = `${formatDuration(item.durationMs)} · ${formatDate(item.discoveredAt)}`;

  const expiry = document.createElement('p');
  expiry.className = 'video-expiry';
  expiry.textContent = item.status === 'clicked'
    ? `Expira: ${formatDate(item.expiresAt)}`
    : `Disponível até: ${formatDate(item.expiresAt)}`;

  const openForm = document.createElement('form');
  openForm.className = 'video-open-form';
  openForm.method = 'post';
  openForm.action = getOpenActionUrl(item.id);
  openForm.target = '_blank';
  openForm.rel = 'noopener';

  const openButton = document.createElement('button');
  openButton.type = 'submit';
  openButton.className = 'open-video-button';
  openButton.textContent = 'Abrir no MEGA';
  openButton.setAttribute('aria-label', `Abrir ${title.textContent} no MEGA em nova aba`);
  openForm.append(openButton);

  details.append(title, metadata, expiry, openForm);
  article.append(thumbnail, details);
  return article;
}

function renderItems(items, { append = false } = {}) {
  if (!append) elements.grid.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const item of items) fragment.append(createVideoCard(item));
  elements.grid.append(fragment);
  elements.grid.hidden = elements.grid.childElementCount === 0;
  elements.emptyState.hidden = elements.grid.childElementCount > 0;
}

function showEmptyState({ title, description, eyebrow = 'Tudo pronto para começar' }) {
  elements.emptyEyebrow.textContent = eyebrow;
  elements.emptyTitle.textContent = title;
  elements.emptyDescription.textContent = description;
  elements.emptyState.hidden = false;
  elements.grid.hidden = true;
}

async function loadCatalog({ append = false } = {}) {
  state.searchController?.abort();
  const controller = new AbortController();
  state.searchController = controller;

  if (!append) {
    state.cursor = null;
    state.loadedCount = 0;
    elements.grid.replaceChildren();
    elements.grid.hidden = false;
    elements.emptyState.hidden = true;
  }

  elements.grid.setAttribute('aria-busy', 'true');
  elements.feedback.textContent = 'Carregando catálogo…';
  elements.loadMore.hidden = true;

  try {
    const requestedQuery = state.query;
    const result = await getCatalogPage({
      query: state.query,
      cursor: append ? state.cursor : null,
      signal: controller.signal,
    });

    renderItems(result.data || [], { append });
    state.loadedQuery = requestedQuery;
    state.cursor = result.page?.nextCursor || null;
    state.hasMore = Boolean(result.page?.hasMore);
    state.loadedCount += (result.data || []).length;
    elements.resultCount.textContent = `${state.loadedCount} ${state.loadedCount === 1 ? 'item' : 'itens'}`;
    elements.loadMore.hidden = !state.hasMore;
    elements.feedback.textContent = state.loadedCount
      ? 'Catálogo atualizado.'
      : 'Nenhum item corresponde à busca.';

    if (state.loadedCount === 0) {
      showEmptyState({
        title: state.query ? 'Nenhum resultado encontrado.' : 'Sua biblioteca está vazia.',
        description: state.query
          ? 'Tente outro título ou termo. A busca considera os metadados disponíveis no catálogo.'
          : 'Quando houver vídeos autorizados e armazenados, eles aparecerão aqui com miniaturas, duração e acesso individual.',
        eyebrow: state.query ? 'Busca' : 'Tudo pronto para começar',
      });
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    elements.resultCount.textContent = '— itens';
    elements.feedback.textContent = error.status === 401 || error.status === 403
      ? 'Acesso protegido. Entre pelo Cloudflare Access.'
      : 'Não foi possível carregar o catálogo.';
    showEmptyState({
      title: error.status === 401 || error.status === 403 ? 'Acesso privado.' : 'Não foi possível conectar.',
      description: error.message || 'Verifique a API e tente novamente.',
      eyebrow: 'Conexão',
    });
  } finally {
    if (state.searchController === controller) {
      elements.grid.setAttribute('aria-busy', 'false');
    }
  }
}

async function loadStatus() {
  try {
    const result = await getSystemStatus();
    setApiState('Conectado', 'online');
    // The gate lives in source control (COPY_AUTHORIZED); the page only reflects it.
    const open = result.copyAuthorized === true;
    elements.operationMode.textContent = open ? 'Catálogo e retenção' : 'Somente metadados';
    if (elements.authStatus) elements.authStatus.textContent = open ? 'Liberado' : 'Bloqueado';
    if (elements.authText) {
      elements.authText.textContent = open
        ? 'O catálogo mostra somente arquivos já armazenados. O primeiro clique inicia a retenção de 24 horas; itens não abertos expiram em sete dias.'
        : 'O catálogo mostra somente arquivos já armazenados. A trava de cópia (COPY_AUTHORIZED) está fechada: apenas metadados são coletados.';
    }
    if (result.monitor?.latestScan?.startedAt) {
      elements.lastScan.textContent = `Última verificação: ${formatDate(result.monitor.latestScan.startedAt)}`;
    }
    renderStats(result.stats);
  } catch (error) {
    setApiState(error.status === 401 || error.status === 403 ? 'Acesso protegido' : 'Indisponível', 'error');
    elements.operationMode.textContent = 'Indisponível';
    renderStats(null);
    if (error.status === 401 || error.status === 403) {
      elements.lastScan.textContent = 'Autenticação necessária';
    } else {
      elements.lastScan.textContent = 'API indisponível ou não configurada';
    }
  }
}

function renderStats(stats) {
  const show = (element, value) => { element.textContent = Number.isFinite(value) ? String(value) : '—'; };
  show(elements.stored, stats?.stored);
  show(elements.clicked, stats?.clicked);
  show(elements.unopened, stats?.unopened);
}

function onSearchInput() {
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(() => {
    const query = elements.search.value.trim();
    // Typing and deleting back to the same text must not hit the API again.
    if (query === state.loadedQuery) return;
    state.query = query;
    loadCatalog();
  }, 350);
}

function setView(view) {
  state.view = view === 'list' ? 'list' : 'grid';
  elements.grid.classList.toggle('is-list', state.view === 'list');
  elements.viewGrid.classList.toggle('is-active', state.view === 'grid');
  elements.viewList.classList.toggle('is-active', state.view === 'list');
  elements.viewGrid.setAttribute('aria-pressed', String(state.view === 'grid'));
  elements.viewList.setAttribute('aria-pressed', String(state.view === 'list'));
  try { localStorage.setItem('ero-scrap-view', state.view); } catch { /* Storage is optional. */ }
}

function initializeView() {
  let savedView = 'grid';
  try {
    const value = localStorage.getItem('ero-scrap-view');
    if (value === 'grid' || value === 'list') savedView = value;
  } catch { /* Storage is optional. */ }
  elements.viewGrid.addEventListener('click', () => setView('grid'));
  elements.viewList.addEventListener('click', () => setView('list'));
  setView(savedView);
}

function initializeKeyboardShortcut() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const isMac = platform.toUpperCase().includes('MAC');
  const shortcut = document.querySelector('#search-shortcut');
  if (shortcut) shortcut.textContent = isMac ? '⌘ K' : 'Ctrl K';

  document.addEventListener('keydown', (event) => {
    if ((isMac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      elements.search.focus();
    }
  });
}

function initialize() {
  initializeTheme();
  elements.themeToggle.addEventListener('click', () => {
    const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
  });
  elements.search.addEventListener('input', onSearchInput);
  elements.loadMore.addEventListener('click', () => loadCatalog({ append: true }));
  initializeView();
  initializeKeyboardShortcut();
  void loadStatus();
  void loadCatalog();
}

initialize();
