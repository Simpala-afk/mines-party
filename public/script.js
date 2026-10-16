const socket = io();

// Состояние клиента
let myPlayerId = null;
let currentRoomState = null;
let soundEnabled = true;
let unreadCount = 0;

// Web Audio API синтезатор (работает без внешних аудиофайлов)
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function playSound(type) {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) audioCtx = new AudioCtx();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (type === 'positive') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.18);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.22);
    } else if (type === 'trap') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.linearRampToValueAtTime(140, now + 0.25);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.start(now);
      osc.stop(now + 0.28);
    } else if (type === 'bomb') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(120, now);
      osc.frequency.exponentialRampToValueAtTime(32, now + 0.45);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.48);
      osc.start(now);
      osc.stop(now + 0.48);
      if (navigator.vibrate) navigator.vibrate([120, 60, 180]);
    } else if (type === 'bank') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(659.25, now + 0.09);
      osc.frequency.setValueAtTime(1046.5, now + 0.18);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    }
  } catch (e) {
    // Игнорируем ограничения автовоспроизведения браузера
  }
}

// DOM-элементы
const screens = {
  auth: document.getElementById('screen-auth'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game')
};

const topbarMeta = document.getElementById('topbar-meta');
const badgeRoom = document.getElementById('badge-room');
const badgeRound = document.getElementById('badge-round');
const btnSound = document.getElementById('btn-sound');

const inputName = document.getElementById('input-name');
const inputRoomCode = document.getElementById('input-room-code');
const btnCreateRoom = document.getElementById('btn-create-room');
const btnJoinRoom = document.getElementById('btn-join-room');

const lobbyRoomCode = document.getElementById('lobby-room-code');
const lobbyCodeBox = document.getElementById('lobby-code-box');
const lobbyCountBadge = document.getElementById('lobby-count-badge');
const lobbySlots = document.getElementById('lobby-slots');
const btnStartGame = document.getElementById('btn-start-game');
const lobbyHint = document.getElementById('lobby-hint');

const playersHud = document.getElementById('players-hud');
const turnBanner = document.getElementById('turn-banner');
const boardGrid = document.getElementById('board-grid');
const btnRisk = document.getElementById('btn-risk');
const btnBank = document.getElementById('btn-bank');
const bankBtnSub = document.getElementById('bank-btn-sub');

const chatDrawer = document.getElementById('chat-drawer');
const chatToggle = document.getElementById('chat-toggle');
const chatChevron = document.getElementById('chat-chevron');
const chatUnread = document.getElementById('chat-unread');
const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');

const modalRound = document.getElementById('modal-round');
const roundModalTitle = document.getElementById('round-modal-title');
const roundStandings = document.getElementById('round-standings');
const btnNextRound = document.getElementById('btn-next-round');

const modalGameover = document.getElementById('modal-gameover');
const gameoverReason = document.getElementById('gameover-reason');
const gameoverWinner = document.getElementById('gameover-winner');
const gameoverStandings = document.getElementById('gameover-standings');
const btnRestartGame = document.getElementById('btn-restart-game');

// Инициализация пустой сетки 5x5 (25 плиток)
function initBoardDOM() {
  boardGrid.innerHTML = '';
  for (let i = 0; i < 25; i++) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.index = i;
    tile.innerHTML = `
      <div class="tile-inner">
        <div class="tile-face tile-front">?</div>
        <div class="tile-face tile-back"></div>
      </div>
    `;
    tile.addEventListener('click', () => handleTileClick(i));
    boardGrid.appendChild(tile);
  }
}
initBoardDOM();

function switchScreen(screenName) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[screenName].classList.add('active');
}

function showToast(message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
}

// Переключение звука
btnSound.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  btnSound.textContent = soundEnabled ? '🔊' : '🔇';
});

// Создание комнаты (с выбранным режимом на 2 или 3 человек) и вход по коду
btnCreateRoom.addEventListener('click', () => {
  const playerName = inputName.value.trim() || 'Охотник';
  const selectedMode = document.querySelector('input[name="max-players"]:checked');
  const maxPlayers = selectedMode ? Number(selectedMode.value) : 3;

  socket.emit('create_room', { playerName, maxPlayers });
});

btnJoinRoom.addEventListener('click', () => {
  const playerName = inputName.value.trim() || 'Охотник';
  const roomCode = inputRoomCode.value.trim().toUpperCase();
  if (roomCode.length !== 5) {
    showToast('Введите 5-значный код комнаты!');
    return;
  }
  socket.emit('join_room', { playerName, roomCode });
});

// Копирование кода комнаты в буфер обмена
lobbyCodeBox.addEventListener('click', () => {
  if (!currentRoomState) return;
  navigator.clipboard?.writeText(currentRoomState.code);
  showToast(`Код ${currentRoomState.code} скопирован!`);
});

// Старт игры создателем
btnStartGame.addEventListener('click', () => {
  socket.emit('start_game');
});

// Клик по конкретной плитке
function handleTileClick(index) {
  if (!currentRoomState || currentRoomState.status !== 'PLAYING') return;
  if (currentRoomState.currentTurnPlayerId !== myPlayerId) {
    showToast('Сейчас ход другого игрока!');
    return;
  }
  const tileData = currentRoomState.board[index];
  if (tileData && tileData.opened) return;

  socket.emit('open_tile', { index });
}

// Кнопка «РИСКНУТЬ» (открывает случайную закрытую плитку, если игрок нажал кнопку вместо плитки)
btnRisk.addEventListener('click', () => {
  if (!currentRoomState || currentRoomState.status !== 'PLAYING') return;
  if (currentRoomState.currentTurnPlayerId !== myPlayerId) return;

  const closedIndices = currentRoomState.board
    .filter(t => !t.opened)
    .map(t => t.index);

  if (closedIndices.length === 0) return;
  const randomIndex = closedIndices[Math.floor(Math.random() * closedIndices.length)];
  socket.emit('open_tile', { index: randomIndex });
});

// Кнопка «ЗАБРАТЬ КУШ (Спасовать)»
btnBank.addEventListener('click', () => {
  if (!currentRoomState || currentRoomState.status !== 'PLAYING') return;
  if (currentRoomState.currentTurnPlayerId !== myPlayerId) return;
  socket.emit('bank_points');
});

// Кнопки модалок
btnNextRound.addEventListener('click', () => {
  socket.emit('next_round');
});

btnRestartGame.addEventListener('click', () => {
  socket.emit('restart_game');
});

// Сворачивание / разворачивание чата
chatToggle.addEventListener('click', () => {
  const isCollapsed = chatDrawer.classList.toggle('collapsed');
  chatChevron.textContent = isCollapsed ? '▲' : '▼';
  if (!isCollapsed) {
    unreadCount = 0;
    chatUnread.hidden = true;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('send_chat', { text });
  chatInput.value = '';
});

// Рендер лобби ожидания (под 2 или 3 игроков)
function renderLobby(state) {
  const maxP = state.maxPlayers || 3;
  lobbyRoomCode.textContent = state.code;
  lobbyCountBadge.textContent = `${state.players.length}/${maxP}`;

  lobbySlots.innerHTML = '';
  for (let i = 0; i < maxP; i++) {
    const player = state.players[i];
    const slot = document.createElement('div');
    slot.className = `slot-item ${player ? 'filled' : ''}`;

    if (player) {
      const isMe = player.id === myPlayerId ? ' (Вы)' : '';
      const isHost = player.id === state.hostId ? ' 👑' : '';
      slot.innerHTML = `
        <span class="slot-name">Игрок ${i + 1}: ${escapeHtml(player.name)}${isMe}${isHost}</span>
        <span class="slot-badge">ГОТОВ</span>
      `;
    } else {
      slot.innerHTML = `
        <span class="slot-name" style="color: var(--text-muted)">Игрок ${i + 1}: Свободный слот...</span>
        <span class="slot-badge">ОЖИДАНИЕ</span>
      `;
    }
    lobbySlots.appendChild(slot);
  }

  const isHost = state.hostId === myPlayerId;
  const fullLobby = state.players.length === maxP;

  if (isHost) {
    btnStartGame.disabled = !fullLobby;
    btnStartGame.textContent = fullLobby
      ? `🔥 НАЧАТЬ ИГРУ (${maxP}/${maxP})`
      : `Ожидание игроков (${state.players.length}/${maxP})...`;
    lobbyHint.textContent = fullLobby
      ? 'Все игроки в сборе! Нажимайте «Начать игру».'
      : 'Отправьте 5-значный код комнаты друзьям.';
  } else {
    btnStartGame.disabled = true;
    btnStartGame.textContent = fullLobby
      ? 'Ожидание запуска создателем комнаты...'
      : `Ожидание игроков (${state.players.length}/${maxP})...`;
    lobbyHint.textContent = 'Игру запускает создатель комнаты 👑.';
  }
}

// Рендер игрового экрана
function renderGame(state) {
  badgeRoom.textContent = `КОД: ${state.code}`;
  badgeRound.textContent = `РАУНД ${state.round}/${state.maxRounds}`;

  // 1. Рендер карточек игроков (2 или 3)
  playersHud.innerHTML = '';
  state.players.forEach(p => {
    const isCurrentTurn = state.status === 'PLAYING' && state.currentTurnPlayerId === p.id;
    const isMe = p.id === myPlayerId;

    let cardClass = 'player-card';
    if (isCurrentTurn) cardClass += ' active-turn';
    if (p.roundStatus === 'BANKED') cardClass += ' status-banked';
    if (p.roundStatus === 'EXPLODED') cardClass += ' status-exploded';

    let statusTag = '<span class="p-status-tag tag-wait">В ИГРЕ</span>';
    if (isCurrentTurn) statusTag = '<span class="p-status-tag tag-turn">ХОДИТ</span>';
    if (p.roundStatus === 'BANKED') statusTag = '<span class="p-status-tag tag-banked">ПАС 💰</span>';
    if (p.roundStatus === 'EXPLODED') statusTag = '<span class="p-status-tag tag-exploded">💥 МИНА</span>';

    const card = document.createElement('div');
    card.className = cardClass;
    card.innerHTML = `
      <div class="p-header">
        <span class="p-name">${escapeHtml(p.name)}${isMe ? ' (Вы)' : ''}</span>
        ${statusTag}
      </div>
      <div class="p-scores">
        <div class="p-score-row">
          <span>Общий:</span>
          <strong>${p.totalScore}</strong>
        </div>
        <div class="p-score-row round-row">
          <span>В раунде:</span>
          <strong>+${p.roundBank}</strong>
        </div>
      </div>
    `;
    playersHud.appendChild(card);
  });

  // 2. Баннер хода и доступность кнопок
  const isMyTurn = state.status === 'PLAYING' && state.currentTurnPlayerId === myPlayerId;
  const activePlayer = state.players.find(p => p.id === state.currentTurnPlayerId);
  const me = state.players.find(p => p.id === myPlayerId);

  if (state.status === 'PLAYING') {
    if (isMyTurn) {
      turnBanner.className = 'turn-banner my-turn';
      turnBanner.textContent = '⚡ ВАШ ХОД! Откройте плитку на поле или заберите куш.';
      boardGrid.classList.add('interactive');
    } else {
      turnBanner.className = 'turn-banner';
      turnBanner.textContent = activePlayer
        ? `⏳ Сейчас ходит: ${activePlayer.name}...`
        : 'Подведение итогов...';
      boardGrid.classList.remove('interactive');
    }
  } else {
    turnBanner.className = 'turn-banner';
    turnBanner.textContent = 'Раунд завершён';
    boardGrid.classList.remove('interactive');
  }

  btnRisk.disabled = !isMyTurn;
  btnBank.disabled = !isMyTurn;
  bankBtnSub.textContent = me ? `Забрать в банк (+${me.roundBank})` : 'Спасовать';

  // 3. Синхронизация 25 плиток поля
  state.board.forEach(tileData => {
    const tileEl = boardGrid.children[tileData.index];
    if (!tileEl) return;

    const backFace = tileEl.querySelector('.tile-back');

    if (tileData.opened || tileData.revealedAtEnd) {
      tileEl.classList.add('flipped', 'disabled');
      tileEl.classList.toggle('unopened-reveal', Boolean(tileData.revealedAtEnd));

      const catClass =
        tileData.category === 'positive'
          ? 'cat-positive'
          : tileData.category === 'trap'
          ? 'cat-trap'
          : 'cat-bomb';

      backFace.className = `tile-face tile-back ${catClass}`;
      backFace.innerHTML = `
        <span>${tileData.label}</span>
        ${tileData.openedBy ? `<span class="tile-opener">${escapeHtml(tileData.openedBy)}</span>` : ''}
      `;
    } else {
      tileEl.className = 'tile';
      backFace.className = 'tile-face tile-back';
      backFace.innerHTML = '';
    }
  });
}

// Динамическая всплывающая плашка прямо над вскрытой плиткой
function spawnFloatingPopup(tileIndex, text, category) {
  const tileEl = boardGrid.children[tileIndex];
  if (!tileEl) return;

  const popup = document.createElement('div');
  const popupClass =
    category === 'positive'
      ? 'popup-positive'
      : category === 'trap'
      ? 'popup-trap'
      : 'popup-bomb';

  popup.className = `floating-popup ${popupClass}`;
  popup.textContent = text;

  tileEl.appendChild(popup);

  if (category === 'bomb') {
    tileEl.classList.add('shake-explosion');
    setTimeout(() => tileEl.classList.remove('shake-explosion'), 550);
  }

  setTimeout(() => {
    popup.remove();
  }, 1400);
}

// SOCKET.IO СОБЫТИЯ
socket.on('joined_room', ({ playerId }) => {
  myPlayerId = playerId;
  topbarMeta.hidden = false;
  chatDrawer.hidden = false;
});

socket.on('room_state', (state) => {
  currentRoomState = state;

  if (state.status === 'LOBBY') {
    switchScreen('lobby');
    renderLobby(state);
  } else {
    switchScreen('game');
    renderGame(state);

    if (state.status === 'PLAYING') {
      modalRound.hidden = true;
      modalGameover.hidden = true;
    }
  }
});

socket.on('tile_opened', ({ index, floatingText, category }) => {
  playSound(category);
  spawnFloatingPopup(index, floatingText, category);
});

socket.on('player_banked', () => {
  playSound('bank');
});

socket.on('round_ended', ({ round, nextRound, players }) => {
  roundModalTitle.textContent = `Итоги раунда ${round}`;
  roundStandings.innerHTML = '';

  const sorted = [...players].sort((a, b) => b.totalScore - a.totalScore);
  sorted.forEach((p, idx) => {
    const statusIcon = p.roundStatus === 'EXPLODED' ? '💥 Подорвался' : '💰 Забрал куш';
    const row = document.createElement('div');
    row.className = 'standing-row';
    row.innerHTML = `
      <span>#${idx + 1} ${escapeHtml(p.name)} <small style="color:var(--text-muted)">(${statusIcon})</small></span>
      <span class="standing-score">${p.totalScore} очк.</span>
    `;
    roundStandings.appendChild(row);
  });

  btnNextRound.textContent = `Начать раунд ${nextRound} ➔`;
  setTimeout(() => {
    modalRound.hidden = false;
  }, 900);
});

socket.on('game_over', ({ winner, standings, reason }) => {
  modalRound.hidden = true;
  gameoverReason.textContent = reason;
  gameoverWinner.textContent = `🏆 Победитель: ${winner.name}!`;

  gameoverStandings.innerHTML = '';
  standings.forEach(s => {
    const row = document.createElement('div');
    row.className = 'standing-row';
    row.innerHTML = `
      <span>#${s.rank} ${escapeHtml(s.name)}</span>
      <span class="standing-score">${s.totalScore} очк.</span>
    `;
    gameoverStandings.appendChild(row);
  });

  setTimeout(() => {
    modalGameover.hidden = false;
  }, 900);
});

socket.on('chat_message', (msg) => {
  const item = document.createElement('div');
  if (msg.isSystem) {
    item.className = `chat-msg sys-${msg.logType || 'info'}`;
    item.innerHTML = `<span class="chat-time">${msg.time}</span> ${escapeHtml(msg.text)}`;
  } else {
    item.className = 'chat-msg';
    item.innerHTML = `
      <span class="chat-time">${msg.time}</span>
      <span class="chat-author">${escapeHtml(msg.sender)}:</span>
      <span>${escapeHtml(msg.text)}</span>
    `;
  }

  chatMessages.appendChild(item);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (chatDrawer.classList.contains('collapsed')) {
    unreadCount++;
    chatUnread.textContent = unreadCount;
    chatUnread.hidden = false;
  }
});

socket.on('error_msg', (msg) => {
  showToast(msg);
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
