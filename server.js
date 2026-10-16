const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MAX_ROUNDS = 3;
const TARGET_SCORE = 3000;

// Хранилище всех активных комнат в памяти сервера
const rooms = new Map();

/**
 * Генерация читаемого 5-значного кода комнаты (без путающихся символов 0/O, 1/I)
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(code));
  return code;
}

/**
 * Генерация и перемешивание поля 5x5 (25 плиток) строго на сервере:
 * - 17 плиток с очками (+50, +100, +150, +250, +500, x2)
 * - 5 плиток-ловушек (-100, /2)
 * - 3 бомбы (сгорание банка раунда и выбывание до конца раунда)
 */
function generateBoard() {
  const deck = [
    // 17 плиток куша
    { type: 'score', value: 50, label: '+50', floatingText: '+50', category: 'positive' },
    { type: 'score', value: 50, label: '+50', floatingText: '+50', category: 'positive' },
    { type: 'score', value: 50, label: '+50', floatingText: '+50', category: 'positive' },
    { type: 'score', value: 50, label: '+50', floatingText: '+50', category: 'positive' },

    { type: 'score', value: 100, label: '+100', floatingText: '+100', category: 'positive' },
    { type: 'score', value: 100, label: '+100', floatingText: '+100', category: 'positive' },
    { type: 'score', value: 100, label: '+100', floatingText: '+100', category: 'positive' },
    { type: 'score', value: 100, label: '+100', floatingText: '+100', category: 'positive' },

    { type: 'score', value: 150, label: '+150', floatingText: '+150', category: 'positive' },
    { type: 'score', value: 150, label: '+150', floatingText: '+150', category: 'positive' },
    { type: 'score', value: 150, label: '+150', floatingText: '+150', category: 'positive' },

    { type: 'score', value: 250, label: '+250', floatingText: '+250', category: 'positive' },
    { type: 'score', value: 250, label: '+250', floatingText: '+250', category: 'positive' },

    { type: 'score', value: 500, label: '+500', floatingText: '+500 КУШ!', category: 'positive' },
    { type: 'score', value: 500, label: '+500', floatingText: '+500 КУШ!', category: 'positive' },

    { type: 'mult', value: 2, label: 'x2', floatingText: 'x2 МНОЖИТЕЛЬ!', category: 'positive' },
    { type: 'mult', value: 2, label: 'x2', floatingText: 'x2 МНОЖИТЕЛЬ!', category: 'positive' },

    // 5 плиток-ловушек
    { type: 'trap_sub', value: 100, label: '-100', floatingText: '-100 ЛОВУШКА!', category: 'trap' },
    { type: 'trap_sub', value: 100, label: '-100', floatingText: '-100 ЛОВУШКА!', category: 'trap' },
    { type: 'trap_sub', value: 100, label: '-100', floatingText: '-100 ЛОВУШКА!', category: 'trap' },
    { type: 'trap_div', value: 2, label: '/2', floatingText: '/2 ПОПОЛАМ!', category: 'trap' },
    { type: 'trap_div', value: 2, label: '/2', floatingText: '/2 ПОПОЛАМ!', category: 'trap' },

    // 3 бомбы
    { type: 'bomb', value: 0, label: '💥', floatingText: '💥 БОМБА!', category: 'bomb' },
    { type: 'bomb', value: 0, label: '💥', floatingText: '💥 БОМБА!', category: 'bomb' },
    { type: 'bomb', value: 0, label: '💥', floatingText: '💥 БОМБА!', category: 'bomb' }
  ];

  // Перемешивание алгоритмом Фишера-Йетса
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck.map((tile, index) => ({
    index,
    ...tile,
    opened: false,
    openedBy: null
  }));
}

/**
 * Формирование безопасного слепка состояния комнаты для клиентов
 * (закрытые плитки не содержат секретных значений)
 */
function getPublicRoomState(room, revealAll = false) {
  return {
    code: room.code,
    status: room.status, // 'LOBBY' | 'PLAYING' | 'ROUND_END' | 'GAME_OVER'
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    round: room.round,
    maxRounds: MAX_ROUNDS,
    targetScore: TARGET_SCORE,
    turnIndex: room.turnIndex,
    currentTurnPlayerId: room.players[room.turnIndex] ? room.players[room.turnIndex].id : null,
    players: room.players.map((p, idx) => ({
      id: p.id,
      name: p.name,
      slot: idx + 1,
      totalScore: p.totalScore,
      roundBank: p.roundBank,
      roundStatus: p.roundStatus, // 'ACTIVE' | 'BANKED' | 'EXPLODED'
      connected: p.connected
    })),
    board: room.board.map(tile => {
      if (tile.opened || revealAll) {
        return {
          index: tile.index,
          opened: tile.opened,
          revealedAtEnd: !tile.opened && revealAll,
          type: tile.type,
          value: tile.value,
          label: tile.label,
          category: tile.category,
          openedBy: tile.openedBy
        };
      }
      return {
        index: tile.index,
        opened: false
      };
    })
  };
}

/**
 * Отправка системного сообщения в чат комнаты
 */
function sendSystemLog(roomCode, text, logType = 'info') {
  const msg = {
    id: Date.now() + Math.random().toString(36).substring(2, 6),
    sender: 'СИСТЕМА',
    text,
    isSystem: true,
    logType, // 'info' | 'gain' | 'trap' | 'bomb' | 'bank'
    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  };
  io.to(roomCode).emit('chat_message', msg);
}

/**
 * Передача хода следующему активному игроку или завершение раунда
 */
function advanceTurnOrEndRound(room) {
  const activePlayers = room.players.filter(p => p.roundStatus === 'ACTIVE' && p.connected);
  const remainingSafeTiles = room.board.filter(t => !t.opened && t.type !== 'bomb');

  // Если не осталось активных игроков или закончились все мирные плитки
  if (activePlayers.length === 0 || remainingSafeTiles.length === 0) {
    // Если мирные плитки кончились, автоматически сохраняем банк оставшимся активным игрокам
    if (remainingSafeTiles.length === 0 && activePlayers.length > 0) {
      activePlayers.forEach(p => {
        p.totalScore += p.roundBank;
        sendSystemLog(
          room.code,
          `На поле больше нет куша! ${p.name} автоматически фиксирует ${p.roundBank} очков.`,
          'bank'
        );
        p.roundBank = 0;
        p.roundStatus = 'BANKED';
      });
    }
    finishRound(room);
    return;
  }

  // Ищем следующего по кругу игрока со статусом ACTIVE
  const total = room.players.length;
  for (let step = 1; step <= total; step++) {
    const nextIdx = (room.turnIndex + step) % total;
    const candidate = room.players[nextIdx];
    if (candidate.roundStatus === 'ACTIVE' && candidate.connected) {
      room.turnIndex = nextIdx;
      break;
    }
  }

  io.to(room.code).emit('room_state', getPublicRoomState(room));
}

/**
 * Завершение раунда и проверка условий конца игры
 */
function finishRound(room) {
  const someoneReachedTarget = room.players.some(p => p.totalScore >= TARGET_SCORE);
  const isFinalRound = room.round >= MAX_ROUNDS;

  if (someoneReachedTarget || isFinalRound) {
    room.status = 'GAME_OVER';
    const sorted = [...room.players].sort((a, b) => b.totalScore - a.totalScore);
    const winner = sorted[0];

    sendSystemLog(
      room.code,
      `🏆 Игра окончена! Победитель — ${winner.name} со счётом ${winner.totalScore} очков!`,
      'bank'
    );

    io.to(room.code).emit('room_state', getPublicRoomState(room, true));
    io.to(room.code).emit('game_over', {
      winner: { id: winner.id, name: winner.name, totalScore: winner.totalScore },
      standings: sorted.map((p, idx) => ({
        rank: idx + 1,
        id: p.id,
        name: p.name,
        totalScore: p.totalScore
      })),
      reason: someoneReachedTarget
        ? `Достигнут целевой куш в ${TARGET_SCORE} очков!`
        : `Завершены все ${MAX_ROUNDS} раунда!`
    });
  } else {
    room.status = 'ROUND_END';
    sendSystemLog(room.code, `Раунд ${room.round} завершён! Подводим итоги.`, 'info');
    io.to(room.code).emit('room_state', getPublicRoomState(room, true));
    io.to(room.code).emit('round_ended', {
      round: room.round,
      nextRound: room.round + 1,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        totalScore: p.totalScore,
        roundStatus: p.roundStatus
      }))
    });
  }
}

/**
 * Старт нового раунда
 */
function startNewRound(room, isFirstRound = false) {
  room.round = isFirstRound ? 1 : room.round + 1;
  room.status = 'PLAYING';
  room.board = generateBoard();

  room.players.forEach(p => {
    if (isFirstRound) {
      p.totalScore = 0;
    }
    p.roundBank = 0;
    p.roundStatus = p.connected ? 'ACTIVE' : 'EXPLODED';
  });

  // Справедливая смена первого хода в каждом раунде
  room.turnIndex = (room.round - 1) % room.players.length;
  if (!room.players[room.turnIndex].connected) {
    const firstConnected = room.players.findIndex(p => p.connected);
    room.turnIndex = firstConnected !== -1 ? firstConnected : 0;
  }

  const starterName = room.players[room.turnIndex].name;
  sendSystemLog(
    room.code,
    `🚀 Раунд ${room.round} из ${MAX_ROUNDS} начался! Первым ходит ${starterName}.`,
    'info'
  );

  io.to(room.code).emit('room_state', getPublicRoomState(room));
}

io.on('connection', (socket) => {
  // 1. Создание новой комнаты (с поддержкой выбора 2 или 3 игроков)
  socket.on('create_room', ({ playerName, maxPlayers }) => {
    const cleanName = String(playerName || '').trim().slice(0, 18) || 'Игрок 1';
    const targetPlayers = Number(maxPlayers) === 2 ? 2 : 3;
    const code = generateRoomCode();

    const room = {
      code,
      hostId: socket.id,
      maxPlayers: targetPlayers,
      status: 'LOBBY',
      round: 1,
      turnIndex: 0,
      players: [
        {
          id: socket.id,
          name: cleanName,
          totalScore: 0,
          roundBank: 0,
          roundStatus: 'ACTIVE',
          connected: true
        }
      ],
      board: []
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerName = cleanName;

    socket.emit('joined_room', { roomCode: code, playerId: socket.id });
    io.to(code).emit('room_state', getPublicRoomState(room));
    sendSystemLog(
      code,
      `${cleanName} создал комнату ${code} (режим на ${room.maxPlayers} чел.). Ожидание (1/${room.maxPlayers})...`,
      'info'
    );
  });

  // 2. Вход в существующую комнату по коду
  socket.on('join_room', ({ playerName, roomCode }) => {
    const cleanName = String(playerName || '').trim().slice(0, 18) || 'Охотник';
    const code = String(roomCode || '').trim().toUpperCase();

    const room = rooms.get(code);
    if (!room) {
      socket.emit('error_msg', 'Комната с таким кодом не найдена!');
      return;
    }

    if (room.status !== 'LOBBY') {
      socket.emit('error_msg', 'Игра в этой комнате уже началась!');
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      socket.emit('error_msg', `Комната уже заполнена (${room.maxPlayers}/${room.maxPlayers})!`);
      return;
    }

    room.players.push({
      id: socket.id,
      name: cleanName,
      totalScore: 0,
      roundBank: 0,
      roundStatus: 'ACTIVE',
      connected: true
    });

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerName = cleanName;

    socket.emit('joined_room', { roomCode: code, playerId: socket.id });
    io.to(code).emit('room_state', getPublicRoomState(room));
    sendSystemLog(
      code,
      `${cleanName} присоединился к лобби (${room.players.length}/${room.maxPlayers}).`,
      'info'
    );
  });

  // 3. Запуск игры создателем комнаты (когда подключены все выбранные игроки: 2/2 или 3/3)
  socket.on('start_game', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    if (room.hostId !== socket.id) {
      socket.emit('error_msg', 'Только создатель комнаты может запустить игру!');
      return;
    }

    if (room.players.length < room.maxPlayers) {
      socket.emit(
        'error_msg',
        `Для старта нужно игроков: ${room.maxPlayers} (сейчас ${room.players.length}/${room.maxPlayers})!`
      );
      return;
    }

    startNewRound(room, true);
  });

  // 4. Открытие плитки («РИСКНУТЬ»)
  socket.on('open_tile', ({ index }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.status !== 'PLAYING') return;

    const currentPlayer = room.players[room.turnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) {
      socket.emit('error_msg', 'Сейчас ход другого игрока!');
      return;
    }

    if (currentPlayer.roundStatus !== 'ACTIVE') {
      socket.emit('error_msg', 'Вы уже завершили этот раунд!');
      return;
    }

    const tileIndex = Number(index);
    if (Number.isNaN(tileIndex) || tileIndex < 0 || tileIndex >= 25) return;

    const tile = room.board[tileIndex];
    if (!tile || tile.opened) {
      socket.emit('error_msg', 'Эта плитка уже открыта!');
      return;
    }

    tile.opened = true;
    tile.openedBy = currentPlayer.name;

    let floatingPopupText = tile.floatingText;
    let popupCategory = tile.category; // 'positive' | 'trap' | 'bomb'

    if (tile.type === 'score') {
      currentPlayer.roundBank += tile.value;
      sendSystemLog(
        code,
        `${currentPlayer.name} поднял +${tile.value}! (В банке раунда: ${currentPlayer.roundBank})`,
        'gain'
      );
    } else if (tile.type === 'mult') {
      if (currentPlayer.roundBank > 0) {
        currentPlayer.roundBank *= 2;
        floatingPopupText = `x2 МНОЖИТЕЛЬ! (${currentPlayer.roundBank})`;
      } else {
        // Если игрок открыл x2 на пустом банке, даём стартовый бонус +100
        currentPlayer.roundBank += 100;
        floatingPopupText = 'x2 МНОЖИТЕЛЬ! (+100)';
      }
      sendSystemLog(
        code,
        `${currentPlayer.name} поймал x2 МНОЖИТЕЛЬ! Банк раунда вырос до ${currentPlayer.roundBank}!`,
        'gain'
      );
    } else if (tile.type === 'trap_sub') {
      currentPlayer.roundBank = Math.max(0, currentPlayer.roundBank - tile.value);
      sendSystemLog(
        code,
        `${currentPlayer.name} нарвался на ловушку -${tile.value}! (В банке раунда: ${currentPlayer.roundBank})`,
        'trap'
      );
    } else if (tile.type === 'trap_div') {
      currentPlayer.roundBank = Math.floor(currentPlayer.roundBank / 2);
      sendSystemLog(
        code,
        `${currentPlayer.name} попал на деление /2! Банк раунда урезан до ${currentPlayer.roundBank}.`,
        'trap'
      );
    } else if (tile.type === 'bomb') {
      const lostPoints = currentPlayer.roundBank;
      currentPlayer.roundBank = 0;
      currentPlayer.roundStatus = 'EXPLODED';
      sendSystemLog(
        code,
        `💥 ${currentPlayer.name} подорвался на мине и потерял ${lostPoints} очков!`,
        'bomb'
      );
    }

    // Синхронное событие анимации вскрытия плитки для всех устройств
    io.to(code).emit('tile_opened', {
      index: tile.index,
      tile: {
        index: tile.index,
        opened: true,
        type: tile.type,
        value: tile.value,
        label: tile.label,
        category: popupCategory,
        openedBy: currentPlayer.name
      },
      floatingText: floatingPopupText,
      category: popupCategory,
      playerId: currentPlayer.id,
      playerName: currentPlayer.name,
      newRoundBank: currentPlayer.roundBank,
      playerStatus: currentPlayer.roundStatus
    });

    advanceTurnOrEndRound(room);
  });

  // 5. Фиксация очков («ЗАБРАТЬ КУШ / Спасовать»)
  socket.on('bank_points', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.status !== 'PLAYING') return;

    const currentPlayer = room.players[room.turnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) {
      socket.emit('error_msg', 'Фиксировать куш можно только в свой ход!');
      return;
    }

    if (currentPlayer.roundStatus !== 'ACTIVE') return;

    const bankedAmount = currentPlayer.roundBank;
    currentPlayer.totalScore += bankedAmount;
    currentPlayer.roundBank = 0;
    currentPlayer.roundStatus = 'BANKED';

    sendSystemLog(
      code,
      `💰 ${currentPlayer.name} зафиксировал ${bankedAmount} очков и вышел из раунда (Общий счёт: ${currentPlayer.totalScore}).`,
      'bank'
    );

    io.to(code).emit('player_banked', {
      playerId: currentPlayer.id,
      playerName: currentPlayer.name,
      bankedAmount,
      totalScore: currentPlayer.totalScore
    });

    advanceTurnOrEndRound(room);
  });

  // 6. Переход к следующему раунду
  socket.on('next_round', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.status !== 'ROUND_END') return;

    startNewRound(room, false);
  });

  // 7. Реванш после окончания всей игры
  socket.on('restart_game', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.status !== 'GAME_OVER') return;

    sendSystemLog(code, '🔄 Запущен реванш! Все счета обнулены.', 'info');
    startNewRound(room, true);
  });

  // 8. Пользовательские сообщения в real-time чате
  socket.on('send_chat', ({ text }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    const cleanText = String(text || '').trim().slice(0, 160);
    if (!cleanText) return;

    const sender = socket.data.playerName || 'Игрок';
    const msg = {
      id: Date.now() + Math.random().toString(36).substring(2, 6),
      sender,
      senderId: socket.id,
      text: cleanText,
      isSystem: false,
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    };

    io.to(code).emit('chat_message', msg);
  });

  // 9. Обработка отключения игрока
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    if (room.status === 'LOBBY') {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        rooms.delete(code);
        return;
      }
      if (room.hostId === socket.id) {
        room.hostId = room.players[0].id;
      }
      sendSystemLog(
        code,
        `${socket.data.playerName} покинул лобби (${room.players.length}/${room.maxPlayers}).`,
        'info'
      );
      io.to(code).emit('room_state', getPublicRoomState(room));
    } else {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.connected = false;
        player.roundBank = 0;
        player.roundStatus = 'EXPLODED';
        sendSystemLog(code, `⚠️ ${player.name} отключился от игры.`, 'trap');

        const anyConnected = room.players.some(p => p.connected);
        if (!anyConnected) {
          rooms.delete(code);
          return;
        }

        if (room.hostId === socket.id) {
          const nextHost = room.players.find(p => p.connected);
          if (nextHost) room.hostId = nextHost.id;
        }

        if (room.status === 'PLAYING') {
          advanceTurnOrEndRound(room);
        } else {
          io.to(code).emit('room_state', getPublicRoomState(room));
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
