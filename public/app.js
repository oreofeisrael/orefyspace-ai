const state = {
  conversations: [],
  currentId: null,
  models: [],
  selectedModel: localStorage.getItem('orefyspace.model') || '',
  responseDensity: localStorage.getItem('orefyspace.density') || 'balanced',
  theme: localStorage.getItem('orefyspace.theme') || 'light',
  defaultModel: '',
  generating: false,
  abortController: null,
  demo: false,
  editingMessageId: null,
  lastPrompt: '',
  lastFailedAssistantId: null,
  projects: [],
  prompts: [],
  projectFilter: '',
};

const $ = (selector) => document.querySelector(selector);
const els = {
  sidebar: $('#sidebar'), list: $('#conversation-list'), messages: $('#messages'), welcome: $('#welcome-state'),
  composer: $('#composer'), input: $('#prompt-input'), send: $('#send-button'), error: $('#error-banner'), errorMessage: $('#error-message'), retry: $('#retry-button'),
  selectedModel: $('#selected-model-label'), modelList: $('#model-list'), modeLabel: $('#mode-label'), demoPill: $('#demo-pill'),
  topbarTitle: $('#topbar-title'), search: $('#conversation-search'), defaultSetting: $('#default-model-setting'), density: $('#response-density'), theme: $('#theme-setting'),
  modelSearch: $('#model-search'), modelCapability: $('#model-capability'), projectList: $('#project-list'), promptList: $('#prompt-list'), promptSearch: $('#prompt-search'), promptCategoryFilter: $('#prompt-category-filter'),
  modelProvider: $('#model-provider'),
  profileName: $('#profile-name'), profileEmail: $('#profile-email'), profileAvatar: $('#profile-avatar'), signOut: $('#sign-out-button'),
};

const authState = { enabled: false, required: false, supabaseUrl: '', publicKey: '', session: null, user: null, mode: 'signin' };
let workspaceStarted = false;

function uid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function escapeHtml(text = '') { return text.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function formatTime(iso) { const date = new Date(iso); return Number.isNaN(date.valueOf()) ? '' : date.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function titleFrom(text) { return text.replace(/\s+/g, ' ').trim().slice(0, 48) || 'New conversation'; }
function streamErrorMessage(value) { return typeof value === 'string' ? value : value?.message || value?.error?.message || 'The model stream returned an error.'; }

function renderMarkdown(source = '') {
  const blocks = source.split(/(```[\s\S]*?```)/g);
  return blocks.map(block => {
    if (block.startsWith('```')) {
      const lines = block.replace(/^```/, '').replace(/```$/, '').replace(/^\w+\n/, '').trim();
      const language = (block.match(/^```(\w+)/) || [,'code'])[1];
      return `<div class="code-block"><div class="code-block-head"><span>${escapeHtml(language)}</span><button type="button" data-copy-code="${encodeURIComponent(lines)}">Copy</button></div><pre>${escapeHtml(lines)}</pre></div>`;
    }
    let html = escapeHtml(block);
    html = html.replace(/^### (.*)$/gm, '<h4>$1</h4>').replace(/^## (.*)$/gm, '<h3>$1</h3>').replace(/^# (.*)$/gm, '<h2>$1</h2>');
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^(?:- |\* )(.*)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g, value => `<ul>${value}</ul>`);
    return html.split(/\n\n+/).map(part => part.trim() ? `<p>${part.replace(/\n/g, '<br />')}</p>` : '').join('');
  }).join('');
}

function currentConversation() { return state.conversations.find(item => item.id === state.currentId); }
function showError(message, canRetry = false) {
  els.errorMessage.textContent = message;
  els.retry.hidden = !canRetry || !state.lastPrompt;
  els.error.hidden = !message;
}

function clearAuthSession() {
  sessionStorage.removeItem('orefyspace.auth.session');
  authState.session = null;
  authState.user = null;
}

function storeAuthSession(value) {
  if (!value?.access_token || !value?.refresh_token) throw new Error('The sign-in service did not return a complete session.');
  const expiresAt = value.expires_at ? Number(value.expires_at) * 1000 : Date.now() + Number(value.expires_in || 3600) * 1000;
  authState.session = { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: expiresAt };
  authState.user = value.user || authState.user;
  sessionStorage.setItem('orefyspace.auth.session', JSON.stringify(authState.session));
}

async function authRequest(endpoint, { method = 'POST', body: payload, token } = {}) {
  const headers = { apikey: authState.publicKey };
  if (payload) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${authState.supabaseUrl}/auth/v1/${endpoint}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.msg || data.message || data.error_description || data.error || 'The sign-in request could not be completed.');
  return data;
}

async function createPkcePair() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  const verifier = [...bytes].map(byte => alphabet[byte % alphabet.length]).join('');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return { verifier, challenge };
}

async function accessToken() {
  if (!authState.enabled || !authState.session) return '';
  if (authState.session.expires_at > Date.now() + 45_000) return authState.session.access_token;
  try {
    const refreshed = await authRequest('token?grant_type=refresh_token', { body: { refresh_token: authState.session.refresh_token } });
    storeAuthSession(refreshed);
    return authState.session.access_token;
  } catch {
    clearAuthSession();
    return '';
  }
}

function showAuthMessage(message, kind = 'info') {
  const target = $('#auth-message');
  target.textContent = message || '';
  target.className = `auth-message ${kind}`;
  target.hidden = !message;
}

function showAuthScreen(message = '') {
  document.body.classList.remove('auth-checking');
  document.body.classList.add('auth-required');
  $('#auth-screen').hidden = false;
  if (message) showAuthMessage(message, 'error');
}

function showWorkspace(user = authState.user) {
  document.body.classList.remove('auth-checking', 'auth-required');
  $('#auth-screen').hidden = true;
  const email = user?.email || '';
  if (els.profileName) els.profileName.textContent = email ? email.split('@')[0] : 'Orefyspace';
  if (els.profileEmail) els.profileEmail.textContent = email || 'Personal workspace';
  if (els.profileAvatar) els.profileAvatar.textContent = email ? email[0].toUpperCase() : 'O';
  if (els.signOut) els.signOut.hidden = !authState.enabled;
}

function setAuthMode(mode) {
  authState.mode = mode === 'signup' ? 'signup' : 'signin';
  const signup = authState.mode === 'signup';
  $('#auth-title').textContent = signup ? 'Create your account' : 'Welcome back';
  $('#auth-description').textContent = signup ? 'Create an account to keep your workspace in sync.' : 'Sign in to continue to your workspace.';
  $('#auth-submit').textContent = signup ? 'Create account' : 'Continue';
  $('#auth-switch-prompt').textContent = signup ? 'Already have an account?' : 'New to Orefyspace?';
  $('#auth-switch-mode').textContent = signup ? 'Sign in' : 'Create an account';
  $('#auth-password').autocomplete = signup ? 'new-password' : 'current-password';
  $('#auth-password').minLength = signup ? 8 : 0;
  $('#auth-password').placeholder = signup ? 'At least 8 characters' : 'Enter your password';
  showAuthMessage('');
}

function authErrorText(value) {
  return typeof value === 'string' ? value.replace(/[_-]+/g, ' ') : 'The sign-in request could not be completed.';
}

async function handleAuthCallback() {
  const callbackUrl = new URL(window.location.href);
  const providerError = callbackUrl.searchParams.get('error_description') || callbackUrl.searchParams.get('error');
  if (providerError) {
    localStorage.removeItem('orefyspace.auth.pkce');
    history.replaceState({}, document.title, callbackUrl.pathname);
    throw new Error(authErrorText(providerError));
  }
  const hash = new URLSearchParams(callbackUrl.hash.replace(/^#/, ''));
  const implicitAccessToken = hash.get('access_token');
  const implicitRefreshToken = hash.get('refresh_token');
  if (implicitAccessToken && implicitRefreshToken) {
    storeAuthSession({ access_token: implicitAccessToken, refresh_token: implicitRefreshToken, expires_in: hash.get('expires_in') || 3600 });
    history.replaceState({}, document.title, callbackUrl.pathname);
  } else if (callbackUrl.searchParams.has('code')) {
    const verifier = localStorage.getItem('orefyspace.auth.pkce');
    if (!verifier) throw new Error('This sign-in link has expired. Please start again.');
    const code = callbackUrl.searchParams.get('code');
    const session = await authRequest('token?grant_type=pkce', { body: { auth_code: code, code_verifier: verifier } });
    storeAuthSession(session);
    localStorage.removeItem('orefyspace.auth.pkce');
    history.replaceState({}, document.title, callbackUrl.pathname);
  }
}

async function verifyBrowserSession() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem('orefyspace.auth.session') || 'null'); } catch { saved = null; }
  if (saved?.access_token && saved?.refresh_token && Number.isFinite(saved.expires_at)) authState.session = saved;
  const token = await accessToken();
  if (!token) return false;
  try {
    authState.user = await authRequest('user', { method: 'GET', token });
    return Boolean(authState.user?.id);
  } catch {
    clearAuthSession();
    return false;
  }
}

async function initializeAuth() {
  wireAuthEvents();
  try {
    const response = await fetch('/api/auth/config', { cache: 'no-store' });
    const config = await response.json();
    authState.enabled = Boolean(config.enabled);
    authState.required = Boolean(config.required);
    authState.supabaseUrl = config.supabaseUrl || '';
    authState.publicKey = config.publicKey || '';
  } catch {
    showAuthScreen('Could not connect to the sign-in service. Refresh the page and try again.');
    return false;
  }
  if (!authState.enabled) {
    if (authState.required) {
      showAuthScreen('Authentication is required, but the server is missing SUPABASE_URL and SUPABASE_ANON_KEY.');
      document.querySelectorAll('#auth-form input, #auth-form button, [data-auth-provider]').forEach(control => { control.disabled = true; });
      return false;
    }
    document.body.classList.remove('auth-checking');
    showWorkspace(null);
    return true;
  }
  try { await handleAuthCallback(); }
  catch (error) { clearAuthSession(); showAuthMessage(error.message, 'error'); }
  if (await verifyBrowserSession()) { showWorkspace(); return true; }
  showAuthScreen();
  return false;
}

function wireAuthEvents() {
  $('#auth-switch-mode').addEventListener('click', () => setAuthMode(authState.mode === 'signup' ? 'signin' : 'signup'));
  $('#auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const signup = authState.mode === 'signup';
    if (signup && password.length < 8) return showAuthMessage('Use a password with at least 8 characters.', 'error');
    const submit = $('#auth-submit');
    submit.disabled = true;
    submit.textContent = signup ? 'Creating account…' : 'Signing in…';
    showAuthMessage('');
    try {
      const endpoint = signup ? `signup?redirect_to=${encodeURIComponent(`${window.location.origin}/`)}` : 'token?grant_type=password';
      const signupPkce = signup ? await createPkcePair() : null;
      if (signupPkce) localStorage.setItem('orefyspace.auth.pkce', signupPkce.verifier);
      const result = await authRequest(endpoint, { body: { email, password, ...(signupPkce ? { code_challenge: signupPkce.challenge, code_challenge_method: 's256' } : {}) } });
      if (signup && !result.access_token) {
        showAuthMessage('Check your email for a confirmation link. Follow it to finish creating your account.', 'success');
        return;
      }
      if (signup) localStorage.removeItem('orefyspace.auth.pkce');
      storeAuthSession(result);
      if (workspaceStarted) return window.location.reload();
      showWorkspace(result.user);
      startWorkspace();
    } catch (error) {
      if (signup) localStorage.removeItem('orefyspace.auth.pkce');
      showAuthMessage(error.message, 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = signup ? 'Create account' : 'Continue';
    }
  });
  document.querySelectorAll('[data-auth-provider]').forEach(button => button.addEventListener('click', () => beginProviderSignIn(button.dataset.authProvider, button)));
  els.signOut?.addEventListener('click', async () => {
    const token = authState.session?.access_token;
    if (token) try { await authRequest('logout?scope=local', { token }); } catch { /* clear the local session even if remote logout is unreachable */ }
    clearAuthSession();
    window.location.reload();
  });
}

async function beginProviderSignIn(provider, button) {
  const originalText = button.textContent;
  button.disabled = true;
  try {
    const { verifier, challenge } = await createPkcePair();
    localStorage.setItem('orefyspace.auth.pkce', verifier);
    const url = new URL(`${authState.supabaseUrl}/auth/v1/authorize`);
    url.searchParams.set('provider', provider);
    url.searchParams.set('redirect_to', `${window.location.origin}${window.location.pathname}`);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 's256');
    if (provider === 'azure') url.searchParams.set('scopes', 'email');
    window.location.assign(url.toString());
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    showAuthMessage(`Could not start sign-in: ${error.message}`, 'error');
  }
}

async function apiFetch(path, options = {}) {
  const token = await accessToken();
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  if (authState.enabled && response.status === 401) {
    clearAuthSession();
    showAuthScreen('Your session expired. Sign in again to continue.');
  }
  return response;
}

async function api(path, options = {}) {
  const response = await apiFetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error([data.error, data.detail].filter(Boolean).join(' ') || 'Something went wrong.');
  return data;
}

function renderConversations() {
  const query = els.search.value.toLowerCase().trim();
  const filtered = state.conversations.filter(item => item.title.toLowerCase().includes(query) && (!state.projectFilter || item.projectId === state.projectFilter));
  if (!filtered.length) { els.list.innerHTML = `<div class="empty-history">${query ? 'No conversations match your search.' : 'Your saved conversations will appear here.'}</div>`; return; }
  els.list.innerHTML = filtered.map(item => `<div class="conversation-item ${item.id === state.currentId ? 'active' : ''}" data-conversation-id="${item.id}"><span class="conversation-title">${escapeHtml(item.title)}</span><small>${escapeHtml(state.projects.find(project => project.id === item.projectId)?.name || formatTime(item.updatedAt))}</small><button class="conversation-menu" data-menu-id="${item.id}" aria-label="Conversation actions">•••</button></div>`).join('');
}

function renderConversation() {
  const conversation = currentConversation();
  const messages = conversation?.messages || [];
  els.welcome.hidden = messages.length > 0;
  els.messages.hidden = messages.length === 0;
  els.topbarTitle.textContent = conversation?.title || 'New conversation';
  if (!messages.length) { els.messages.innerHTML = ''; return; }
  els.messages.innerHTML = messages.map((message, index) => {
    const isUser = message.role === 'user';
    return `<article class="message ${isUser ? 'user' : 'assistant'}"><div class="message-avatar">${isUser ? 'O' : '✦'}</div><div class="message-content"><div class="message-meta"><span>${isUser ? 'You' : `Orefyspace AI${message.provider ? ` · ${escapeHtml(message.provider)}` : ''}`}</span><span class="message-tools"><button type="button" data-copy-message="${index}">Copy</button>${isUser ? `<button type="button" data-edit-message="${index}">Edit</button>` : `<button type="button" data-regenerate="${index}">Regenerate</button>`}</span></div><div class="message-body">${message.pending ? '<div class="typing-dots"><span></span><span></span><span></span></div>' : renderMarkdown(message.content)}</div></div></article>`;
  }).join('');
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function persistConversation(conversation) {
  try { await api('/api/conversations', { method: 'POST', body: JSON.stringify(conversation) }); } catch (error) { showError(`Saved locally for now. ${error.message}`); }
}

function createConversation(focusInput = true) {
  const conversation = { id: uid(), title: 'New conversation', model: state.selectedModel || state.defaultModel || '', projectId: state.projectFilter || null, archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
  state.conversations.unshift(conversation); state.currentId = conversation.id; renderConversations(); renderConversation(); if (focusInput) els.input.focus(); showError(''); return conversation;
}

async function loadConversation(id) { state.currentId = id; const conversation = currentConversation(); if (conversation?.model) { state.selectedModel = conversation.model.includes(':') ? conversation.model : `openrouter:${conversation.model}`; localStorage.setItem('orefyspace.model', state.selectedModel); renderModels(); } renderConversations(); renderConversation(); closeSidebarOnMobile(); }

async function deleteConversation(id) {
  state.conversations = state.conversations.filter(item => item.id !== id);
  try { await api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { /* local state is still correct */ }
  if (state.currentId === id) { state.currentId = state.conversations[0]?.id || null; if (!state.currentId) createConversation(); }
  renderConversations(); renderConversation();
}

function openModal(id) { const modal = document.getElementById(id); if (modal) modal.hidden = false; }
function closeModal(id) { const modal = document.getElementById(id); if (modal) modal.hidden = true; }
function closeSidebarOnMobile() { if (window.innerWidth <= 800) els.sidebar.classList.remove('open'); }

function renderModels() {
  const models = state.models;
  if (!models.length) {
    state.selectedModel = '';
    els.selectedModel.textContent = state.demo ? 'Live models unavailable' : 'No models available';
    els.defaultSetting.innerHTML = `<option value="">${state.demo ? 'Live models unavailable in demo mode' : 'No models available'}</option>`;
    els.defaultSetting.disabled = true;
    els.modelList.innerHTML = `<div class="empty-history">${state.demo ? 'Configure the server environment key to load live models.' : 'The model catalogue could not be loaded. Try again later.'}</div>`;
    return;
  }
  els.defaultSetting.disabled = false;
  if (!state.selectedModel) state.selectedModel = state.defaultModel || models[0].key;
  const previousModel = state.selectedModel;
  const current = models.find(model => model.key === state.selectedModel) || models.find(model => model.configured) || models[0];
  state.selectedModel = current.key;
  if (previousModel && previousModel !== current.key && !state.demo) showError(`The previously selected model is unavailable. Using ${current.providerName}: ${current.id}.`);
  localStorage.setItem('orefyspace.model', state.selectedModel);
  els.selectedModel.textContent = current.name || current.id;
  els.defaultSetting.innerHTML = models.map(model => `<option value="${escapeHtml(model.key)}">${escapeHtml(model.providerName)} · ${escapeHtml(model.name || model.id)}</option>`).join('');
  els.defaultSetting.value = state.selectedModel;
  const query = (els.modelSearch?.value || '').toLowerCase().trim();
  const capability = els.modelCapability?.value || 'all';
  const provider = els.modelProvider?.value || 'all';
  if (els.modelProvider) {
    const currentProvider = els.modelProvider.value || 'all';
    const providerNames = [...new Map(models.map(model => [model.provider, model.providerName])).entries()];
    els.modelProvider.innerHTML = `<option value="all">All providers</option>${providerNames.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join('')}`;
    els.modelProvider.value = providerNames.some(([id]) => id === currentProvider) ? currentProvider : 'all';
  }
  const filtered = models.filter(model => {
    const matchesQuery = !query || `${model.name} ${model.id}`.toLowerCase().includes(query);
    const matchesCapability = capability === 'all' || (capability === 'vision' && model.supportsVision) || (capability === 'reasoning' && model.supportsReasoning);
    const matchesProvider = provider === 'all' || model.provider === provider;
    return matchesQuery && matchesCapability && matchesProvider;
  });
  els.modelList.innerHTML = filtered.slice(0, 80).map(model => `<button type="button" class="model-option ${model.key === state.selectedModel ? 'selected' : ''}" data-model-id="${escapeHtml(model.key)}" ${model.configured ? '' : 'disabled'}><span><strong>${escapeHtml(model.name || model.id)}</strong><small>${escapeHtml(model.providerName)} · ${escapeHtml(model.id)} · ${escapeHtml(model.freeStatus || 'Availability varies')} · ${model.contextLength ? `${Math.round(model.contextLength / 1000)}k context` : 'Context limit unavailable'}${model.supportsVision ? ' · Vision' : ''}${model.supportsReasoning ? ' · Reasoning' : ''}</small></span><span class="model-check">${model.key === state.selectedModel ? '✓' : model.configured ? '' : 'Not configured'}</span></button>`).join('') || '<div class="empty-history">No models match those filters.</div>';
}

async function loadModels() {
  try {
    const result = await api('/api/models'); state.models = result.data || []; state.defaultModel = result.defaultModel || ''; if (!state.selectedModel || !state.selectedModel.includes(':')) state.selectedModel = state.defaultModel; state.demo = Boolean(result.demo); renderModels();
    els.modeLabel.textContent = state.demo ? 'Demo mode' : 'OpenRouter connected'; els.modeLabel.previousElementSibling.className = `status-dot ${state.demo ? 'demo' : ''}`; els.demoPill.hidden = !state.demo;
  } catch (error) { state.demo = false; state.models = []; els.modeLabel.textContent = 'Connection unavailable'; els.modeLabel.previousElementSibling.className = 'status-dot error'; showError(error.message); renderModels(); }
}

function renderProjects() {
  els.projectList.innerHTML = `<button type="button" class="library-item ${!state.projectFilter ? 'selected' : ''}" data-project-filter=""><span><strong>All conversations</strong><small>Show every active conversation</small></span><span class="library-count">${state.conversations.length}</span></button>` + state.projects.map(project => `<div class="library-item ${state.projectFilter === project.id ? 'selected' : ''}"><button type="button" class="library-main" data-project-filter="${project.id}"><span class="project-dot" style="background:${escapeHtml(project.color || '#00F05A')}"></span><span><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.description || 'No description')} · ${state.conversations.filter(item => item.projectId === project.id).length} chats</small></span></button><button type="button" class="library-delete" data-delete-project="${project.id}" aria-label="Delete project">×</button></div>`).join('');
}

function renderPrompts() {
  const query = (els.promptSearch?.value || '').toLowerCase().trim();
  const category = els.promptCategoryFilter?.value || 'all';
  const categories = [...new Set(state.prompts.map(prompt => prompt.category).filter(Boolean))].sort();
  if (els.promptCategoryFilter) {
    const current = els.promptCategoryFilter.value || 'all';
    els.promptCategoryFilter.innerHTML = `<option value="all">All categories</option>${categories.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
    els.promptCategoryFilter.value = categories.includes(current) ? current : 'all';
  }
  const filtered = state.prompts.filter(prompt => (!query || `${prompt.title} ${prompt.category} ${prompt.content}`.toLowerCase().includes(query)) && (category === 'all' || prompt.category === category));
  els.promptList.innerHTML = filtered.map(prompt => `<div class="library-item prompt-library-item"><button type="button" class="library-main" data-insert-prompt="${prompt.id}"><span><strong>${escapeHtml(prompt.title)}</strong><small>${escapeHtml(prompt.category || 'General')} · ${escapeHtml(prompt.content.slice(0, 110))}${prompt.content.length > 110 ? '…' : ''}</small></span></button><div class="library-actions"><button type="button" data-edit-prompt="${prompt.id}" aria-label="Edit prompt">Edit</button><button type="button" data-duplicate-prompt="${prompt.id}" aria-label="Duplicate prompt">Duplicate</button><button type="button" data-delete-prompt="${prompt.id}" aria-label="Delete prompt">×</button></div></div>`).join('') || '<div class="empty-history">No saved prompts match your search.</div>';
}

async function loadWorkspaceLibraries() {
  try { state.projects = await api('/api/projects'); } catch { state.projects = []; }
  try { state.prompts = await api('/api/prompts'); } catch { state.prompts = []; }
  renderConversations(); renderProjects(); renderPrompts();
}

async function loadConversations() {
  try { state.conversations = await api('/api/conversations'); } catch { state.conversations = []; }
  if (!state.currentId && state.conversations[0]) state.currentId = state.conversations[0].id;
  const active = currentConversation(); if (active?.model) state.selectedModel = active.model.includes(':') ? active.model : `openrouter:${active.model}`;
  if (!state.currentId) createConversation(false); else { renderConversations(); renderConversation(); }
}

function appendMessage(role, content, pending = false) {
  const conversation = currentConversation() || createConversation();
  const message = { id: uid(), role, content, pending, createdAt: new Date().toISOString() };
  conversation.messages.push(message); conversation.updatedAt = new Date().toISOString();
  if (role === 'user' && conversation.title === 'New conversation') conversation.title = titleFrom(content);
  renderConversations(); renderConversation(); return message;
}

async function saveCurrent() { const conversation = currentConversation(); if (conversation) await persistConversation(conversation); }

async function sendMessage(text = els.input.value.trim()) {
  if (!text || state.generating) return;
  state.lastPrompt = text;
  state.lastFailedAssistantId = null;
  showError(''); els.input.value = ''; autoResize();
  const activeConversation = currentConversation() || createConversation();
  activeConversation.model = state.selectedModel || activeConversation.model || state.defaultModel;
  activeConversation.projectId = activeConversation.projectId || state.projectFilter || null;
  if (state.editingMessageId) {
    const editIndex = activeConversation.messages.findIndex(message => message.id === state.editingMessageId);
    if (editIndex >= 0) activeConversation.messages.splice(editIndex);
    state.editingMessageId = null;
  }
  appendMessage('user', text); const assistant = appendMessage('assistant', '', true); state.generating = true; els.send.innerHTML = '<span aria-hidden="true">■</span>'; els.send.setAttribute('aria-label', 'Stop generation');
  state.abortController = new AbortController();
  const conversation = currentConversation();
  const densityInstruction = state.responseDensity === 'concise'
    ? 'Prefer concise, direct answers with minimal filler.'
    : state.responseDensity === 'detailed'
      ? 'Give thorough, well-structured answers with useful context and examples.'
      : 'Give balanced answers: clear, practical, and appropriately detailed.';
  const messages = [{ role: 'system', content: `You are Orefyspace AI, a practical and encouraging personal AI workspace assistant. ${densityInstruction}` }, ...conversation.messages.filter(message => !message.pending).map(message => ({ role: message.role, content: message.content }))];
  try {
    const response = await apiFetch('/api/chat', { method: 'POST', signal: state.abortController.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: state.selectedModel, messages }) });
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error([error.error, error.detail].filter(Boolean).join(' ') || 'The model could not answer.'); }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n'); buffer = events.pop() || '';
      for (const event of events) {
        const line = event.split('\n').find(item => item.startsWith('data: ')); if (!line) continue; const payload = line.slice(6); if (payload === '[DONE]') continue;
        try { const data = JSON.parse(payload); if (data.type === 'meta') { assistant.provider = data.provider; if (data.fallbackFrom) assistant.content += `Provider fallback: ${data.fallbackFrom} was unavailable, so this response used ${data.provider}:${data.model}.\n\n`; } else if (data.type === 'token') assistant.content += data.token; else if (data.choices?.[0]?.delta?.content) assistant.content += data.choices[0].delta.content; else if (data.error) throw new Error(streamErrorMessage(data.error)); } catch (error) { if (error.message !== 'Unexpected end of JSON input') throw error; }
        assistant.pending = false; renderConversation();
      }
    }
    assistant.pending = false; if (!assistant.content) assistant.content = 'The model returned an empty response.';
  } catch (error) {
    assistant.pending = false; assistant.content = error.name === 'AbortError' ? 'Generation stopped.' : (assistant.content || `The request failed: ${error.message}`); state.lastFailedAssistantId = error.name === 'AbortError' ? null : assistant.id; showError(error.name === 'AbortError' ? '' : error.message, error.name !== 'AbortError');
  } finally { state.generating = false; state.abortController = null; els.send.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; els.send.setAttribute('aria-label', 'Send message'); renderConversation(); await saveCurrent(); }
}

function retryLastPrompt() {
  const conversation = currentConversation();
  if (!conversation || !state.lastPrompt || state.generating) return;
  const lastAssistant = conversation.messages.at(-1);
  const lastUser = conversation.messages.at(-2);
  if (lastAssistant?.role === 'assistant' && lastAssistant.id === state.lastFailedAssistantId) conversation.messages.pop();
  if (lastUser?.role === 'user' && lastUser.content === state.lastPrompt) conversation.messages.pop();
  renderConversation();
  sendMessage(state.lastPrompt);
}

async function exportConversation(id) {
  const response = await apiFetch(`/api/conversations/${encodeURIComponent(id)}/export`);
  if (!response.ok) throw new Error('Could not export this conversation.');
  const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'conversation.md'; link.click(); URL.revokeObjectURL(link.href);
}

async function archiveConversation(id) {
  const conversation = state.conversations.find(item => item.id === id); if (!conversation) return;
  conversation.archived = true;
  await api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
  state.conversations = state.conversations.filter(item => item.id !== id);
  if (state.currentId === id) { state.currentId = state.conversations[0]?.id || null; if (!state.currentId) createConversation(); }
  renderConversations(); renderConversation();
}

function autoResize() { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`; }

function wireEvents() {
  $('#new-chat').addEventListener('click', createConversation); $('#open-sidebar').addEventListener('click', () => els.sidebar.classList.add('open')); $('#close-sidebar').addEventListener('click', closeSidebarOnMobile); els.retry.addEventListener('click', retryLastPrompt);
  $('#open-settings').addEventListener('click', () => openModal('settings-modal')); $('#top-settings').addEventListener('click', () => openModal('settings-modal')); $('#model-button').addEventListener('click', () => { renderModels(); openModal('model-modal'); }); $('#open-projects').addEventListener('click', () => { renderProjects(); openModal('projects-modal'); }); $('#open-prompts').addEventListener('click', () => { renderPrompts(); openModal('prompts-modal'); });
  // Bind modal controls directly as well as through delegation so close actions remain reliable.
  document.querySelectorAll('[data-close-modal]').forEach(button => { button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); closeModal(button.dataset.closeModal); }); });
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => { backdrop.addEventListener('click', event => { if (event.target === backdrop) closeModal(backdrop.id); }); });
  $('#attach-button').addEventListener('click', () => $('#file-input').click()); $('#file-input').addEventListener('change', event => { const names = [...event.target.files].map(file => file.name).join(', '); if (names) { els.input.value += `${els.input.value ? '\n' : ''}[Attached: ${names}]`; autoResize(); } });
  els.composer.addEventListener('submit', event => { event.preventDefault(); if (state.generating) state.abortController?.abort(); else sendMessage(); }); els.input.addEventListener('input', autoResize); els.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); els.composer.requestSubmit(); } });
  els.search.addEventListener('input', renderConversations); $('#clear-search').addEventListener('click', () => { els.search.value = ''; renderConversations(); });
  document.addEventListener('click', async event => {
    const conversation = event.target.closest('[data-conversation-id]'); if (conversation && !event.target.closest('[data-menu-id]')) return loadConversation(conversation.dataset.conversationId);
    const menu = event.target.closest('[data-menu-id]');
    if (menu) {
      const id = menu.dataset.menuId;
      const action = window.prompt('Type rename, move, archive, export, or delete');
      if (action === 'delete') return deleteConversation(id);
      if (action === 'archive') return archiveConversation(id);
      if (action === 'export') return exportConversation(id);
      if (action === 'move') {
        const options = state.projects.map(project => `${project.name}=${project.id}`).join(', ');
        const picked = window.prompt(`Enter a project name, or blank to remove. Available: ${options}`);
        const project = state.projects.find(value => value.name.toLowerCase() === picked?.trim().toLowerCase());
        const item = state.conversations.find(value => value.id === id);
        if (item) {
          item.projectId = project?.id || null;
          await api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ projectId: item.projectId }) });
          renderConversations();
          renderProjects();
        }
      }
      if (action === 'rename') {
        const next = window.prompt('New conversation name');
        if (next) {
          const item = state.conversations.find(value => value.id === id);
          if (item) {
            item.title = next.trim();
            await api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title: item.title }) });
            renderConversations();
            renderConversation();
          }
        }
      }
    }
    const model = event.target.closest('[data-model-id]'); if (model) { state.selectedModel = model.dataset.modelId; localStorage.setItem('orefyspace.model', state.selectedModel); const conversation = currentConversation(); if (conversation) { conversation.model = state.selectedModel; persistConversation(conversation); } renderModels(); closeModal('model-modal'); }
    const copy = event.target.closest('[data-copy-message]'); if (copy) { const message = currentConversation()?.messages[Number(copy.dataset.copyMessage)]; if (message) navigator.clipboard?.writeText(message.content); }
    const code = event.target.closest('[data-copy-code]'); if (code) navigator.clipboard?.writeText(decodeURIComponent(code.dataset.copyCode));
    const edit = event.target.closest('[data-edit-message]'); if (edit) { const message = currentConversation()?.messages[Number(edit.dataset.editMessage)]; if (message) { state.editingMessageId = message.id; els.input.value = message.content; autoResize(); els.input.focus(); } }
    const regenerate = event.target.closest('[data-regenerate]'); if (regenerate && !state.generating) { const conversation = currentConversation(); const index = Number(regenerate.dataset.regenerate); const previous = conversation.messages[index - 1]; if (previous?.role === 'user') { conversation.messages.splice(index); renderConversation(); sendMessage(previous.content); } }
    const prompt = event.target.closest('[data-prompt]'); if (prompt) { els.input.value = prompt.dataset.prompt; autoResize(); els.input.focus(); }
    const projectFilter = event.target.closest('[data-project-filter]'); if (projectFilter) { state.projectFilter = projectFilter.dataset.projectFilter; renderProjects(); renderConversations(); closeModal('projects-modal'); }
    const deleteProject = event.target.closest('[data-delete-project]'); if (deleteProject) { if (window.confirm('Delete this project? Conversations will remain active.')) { await api(`/api/projects/${encodeURIComponent(deleteProject.dataset.deleteProject)}`, { method: 'DELETE' }); state.projects = state.projects.filter(project => project.id !== deleteProject.dataset.deleteProject); if (state.projectFilter === deleteProject.dataset.deleteProject) state.projectFilter = ''; renderProjects(); renderConversations(); } }
    const insertPrompt = event.target.closest('[data-insert-prompt]'); if (insertPrompt) { const saved = state.prompts.find(prompt => prompt.id === insertPrompt.dataset.insertPrompt); if (saved) { els.input.value = els.input.value ? `${els.input.value}\n\n${saved.content}` : saved.content; autoResize(); els.input.focus(); closeModal('prompts-modal'); } }
    const deletePrompt = event.target.closest('[data-delete-prompt]'); if (deletePrompt) { if (window.confirm('Delete this saved prompt?')) { await api(`/api/prompts/${encodeURIComponent(deletePrompt.dataset.deletePrompt)}`, { method: 'DELETE' }); state.prompts = state.prompts.filter(prompt => prompt.id !== deletePrompt.dataset.deletePrompt); renderPrompts(); } }
    const duplicatePrompt = event.target.closest('[data-duplicate-prompt]'); if (duplicatePrompt) { const saved = state.prompts.find(prompt => prompt.id === duplicatePrompt.dataset.duplicatePrompt); if (saved) { const copy = await api('/api/prompts', { method: 'POST', body: JSON.stringify({ title: `${saved.title} copy`, category: saved.category, content: saved.content }) }); state.prompts.unshift(copy); renderPrompts(); } }
    const editPrompt = event.target.closest('[data-edit-prompt]'); if (editPrompt) { const saved = state.prompts.find(prompt => prompt.id === editPrompt.dataset.editPrompt); if (saved) { const title = window.prompt('Prompt title', saved.title); const content = window.prompt('Prompt content', saved.content); if (title && content) { const updated = await api(`/api/prompts/${encodeURIComponent(saved.id)}`, { method: 'PATCH', body: JSON.stringify({ title, content, category: saved.category }) }); Object.assign(saved, updated); renderPrompts(); } } }
    const close = event.target.closest('[data-close-modal]'); if (close) closeModal(close.dataset.closeModal);
  });
  $('#project-form').addEventListener('submit', async event => { event.preventDefault(); const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: $('#project-name').value, description: $('#project-description').value }) }); state.projects.unshift(project); $('#project-form').reset(); renderProjects(); renderConversations(); });
  $('#prompt-form').addEventListener('submit', async event => { event.preventDefault(); const prompt = await api('/api/prompts', { method: 'POST', body: JSON.stringify({ title: $('#prompt-title').value, category: $('#prompt-category').value || 'General', content: $('#prompt-content').value }) }); state.prompts.unshift(prompt); $('#prompt-form').reset(); renderPrompts(); });
  els.modelSearch.addEventListener('input', renderModels); els.modelProvider.addEventListener('change', renderModels); els.modelCapability.addEventListener('change', renderModels); els.promptSearch.addEventListener('input', renderPrompts); els.promptCategoryFilter.addEventListener('change', renderPrompts);
  const settingsStatus = $('#settings-status');
  const markSettingsSaved = () => { if (settingsStatus) settingsStatus.textContent = 'Settings saved on this device.'; };
  els.defaultSetting.addEventListener('change', event => { state.defaultModel = event.target.value; state.selectedModel = event.target.value; localStorage.setItem('orefyspace.defaultModel', state.defaultModel); localStorage.setItem('orefyspace.model', state.selectedModel); renderModels(); markSettingsSaved(); });
  els.density.addEventListener('change', event => { state.responseDensity = event.target.value; localStorage.setItem('orefyspace.density', state.responseDensity); markSettingsSaved(); });
  els.theme.addEventListener('change', event => { state.theme = event.target.value; localStorage.setItem('orefyspace.theme', state.theme); document.documentElement.dataset.theme = state.theme; markSettingsSaved(); });
  els.defaultSetting.value = localStorage.getItem('orefyspace.defaultModel') || state.selectedModel;
  els.density.value = state.responseDensity; els.theme.value = state.theme; document.documentElement.dataset.theme = state.theme;
  document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); createConversation(); } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); els.search.focus(); } if (event.key === 'Escape') { ['model-modal', 'settings-modal', 'projects-modal', 'prompts-modal'].forEach(closeModal); } });
}

function startWorkspace() {
  if (workspaceStarted) return;
  workspaceStarted = true;
  wireEvents();
  Promise.all([loadModels(), loadConversations(), loadWorkspaceLibraries()]);
}

document.addEventListener('DOMContentLoaded', async () => {
  if (await initializeAuth()) startWorkspace();
});
