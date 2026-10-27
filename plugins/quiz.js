const config = require("../config");
const { getLang } = require("../lib/utils/language");
const { createStore } = require("../lib/utils/gameStore");
const { safeLog } = require("../lib/utils/http");

/**
 * Quiz & number guessing game
 *   .quiz   [start|hint|stop]   a question, answered by replying to it
 *   .guess  [start|<n>|stop]    guess a number between 1 and 100
 */

const QUIZ_TTL_MS = 10 * 60 * 1000;
const GUESS_TTL_MS = 15 * 60 * 1000;
const QUIZ_MAX_ATTEMPTS = 3;
const GUESS_MAX = 100;
const GUESS_MAX_ATTEMPTS = 10;
const MAX_BOT_IDS = 20;

const quizStore = createStore("quiz", { ttlMs: QUIZ_TTL_MS });
const guessStore = createStore("guess", { ttlMs: GUESS_TTL_MS });

// Question content per language (the bot language, config.LANG). `answers` are compared
// after normalization (case, accents and punctuation ignored); the first one is displayed.
const QUESTIONS = {
  en: [
    {
      category: "Geography",
      question: "What is the capital of France?",
      answers: ["Paris"],
      hints: ["It's a city", "Known for the Eiffel Tower", "Starts with P"],
    },
    {
      category: "Math",
      question: "What is 15 × 8?",
      answers: ["120"],
      hints: ["It's a number", "Between 100 and 150", "Divisible by 10"],
    },
    {
      category: "Art",
      question: "Who painted the Mona Lisa?",
      answers: ["Leonardo da Vinci", "da Vinci", "Leonardo", "Vinci"],
      hints: ["Italian artist", "Renaissance period", "Also designed flying machines"],
    },
    {
      category: "Science",
      question: "What is the largest planet in our solar system?",
      answers: ["Jupiter"],
      hints: ["A gas giant", "Named after a Roman god", "Has the Great Red Spot"],
    },
    {
      category: "History",
      question: "In which year did World War II end?",
      answers: ["1945"],
      hints: ["20th century", "Between 1940 and 1950", "After the atomic bombs"],
    },
    {
      category: "Geography",
      question: "What is the longest river in Africa?",
      answers: ["Nile", "The Nile", "Nile River"],
      hints: ["It flows north", "It crosses Egypt", "Starts with N"],
    },
    {
      category: "Science",
      question: "What is the chemical formula of water?",
      answers: ["H2O"],
      hints: ["Two elements", "Two hydrogen atoms", "Plus one oxygen atom"],
    },
    {
      category: "Geography",
      question: "What is the largest ocean on Earth?",
      answers: ["Pacific", "Pacific Ocean", "The Pacific"],
      hints: ["It covers about a third of the planet", "Its name means peaceful", "Starts with P"],
    },
    {
      category: "Literature",
      question: "Who wrote Romeo and Juliet?",
      answers: ["William Shakespeare", "Shakespeare"],
      hints: ["English playwright", "Born in Stratford-upon-Avon", "Also wrote Hamlet"],
    },
    {
      category: "Geography",
      question: "How many continents are there?",
      answers: ["7", "seven"],
      hints: ["It's a number", "Fewer than 10", "A lucky number"],
    },
    {
      category: "Math",
      question: "What is the square root of 144?",
      answers: ["12", "twelve"],
      hints: ["It's a number", "A dozen", "10 + 2"],
    },
    {
      category: "Geography",
      question: "What is the capital of Japan?",
      answers: ["Tokyo"],
      hints: ["It's a huge city", "Formerly called Edo", "Starts with T"],
    },
  ],
  fr: [
    {
      category: "Géographie",
      question: "Quelle est la capitale de l'Italie ?",
      answers: ["Rome"],
      hints: ["C'est une ville", "On l'appelle la ville éternelle", "Elle commence par R"],
    },
    {
      category: "Maths",
      question: "Combien font 15 × 8 ?",
      answers: ["120", "cent vingt"],
      hints: ["C'est un nombre", "Entre 100 et 150", "Divisible par 10"],
    },
    {
      category: "Art",
      question: "Qui a peint la Joconde ?",
      answers: ["Léonard de Vinci", "de Vinci", "Léonard", "Vinci"],
      hints: ["Artiste italien", "Époque de la Renaissance", "Il a aussi dessiné des machines volantes"],
    },
    {
      category: "Science",
      question: "Quelle est la plus grande planète du système solaire ?",
      answers: ["Jupiter"],
      hints: ["Une géante gazeuse", "Elle porte le nom d'un dieu romain", "Elle a une Grande Tache rouge"],
    },
    {
      category: "Histoire",
      question: "En quelle année la Seconde Guerre mondiale s'est-elle terminée ?",
      answers: ["1945"],
      hints: ["XXe siècle", "Entre 1940 et 1950", "Après les bombes atomiques"],
    },
    {
      category: "Géographie",
      question: "Quel est le plus long fleuve d'Afrique ?",
      answers: ["Le Nil", "Nil"],
      hints: ["Il coule vers le nord", "Il traverse l'Égypte", "Il commence par N"],
    },
    {
      category: "Science",
      question: "Quelle est la formule chimique de l'eau ?",
      answers: ["H2O"],
      hints: ["Deux éléments", "Deux atomes d'hydrogène", "Et un atome d'oxygène"],
    },
    {
      category: "Géographie",
      question: "Quel est le plus grand océan de la Terre ?",
      answers: ["Pacifique", "Océan Pacifique", "Le Pacifique"],
      hints: ["Il couvre environ un tiers de la planète", "Son nom veut dire paisible", "Il commence par P"],
    },
    {
      category: "Littérature",
      question: "Qui a écrit « Les Misérables » ?",
      answers: ["Victor Hugo", "Hugo"],
      hints: ["Écrivain français du XIXe siècle", "Il a aussi écrit Notre-Dame de Paris", "Son prénom est Victor"],
    },
    {
      category: "Géographie",
      question: "Combien y a-t-il de continents ?",
      answers: ["7", "sept"],
      hints: ["C'est un nombre", "Moins de 10", "Un nombre porte-bonheur"],
    },
    {
      category: "Maths",
      question: "Quelle est la racine carrée de 144 ?",
      answers: ["12", "douze"],
      hints: ["C'est un nombre", "Une douzaine", "10 + 2"],
    },
    {
      category: "Géographie",
      question: "Quelle est la capitale du Japon ?",
      answers: ["Tokyo"],
      hints: ["C'est une ville immense", "Elle s'appelait Edo autrefois", "Elle commence par T"],
    },
  ],
};

/** Lower case, accents and punctuation removed, spaces collapsed */
function normalizeAnswer(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function questionPool() {
  const lang = String(config.LANG || "en").slice(0, 2).toLowerCase();
  return QUESTIONS[lang] || QUESTIONS.en;
}

/** The command word that ran: ctx.command, or parsed from the body when called without a ctx */
function commandOf(message, ctx) {
  if (ctx && ctx.command) return String(ctx.command).toLowerCase();
  const prefix = config.PREFIX || "";
  const body = String(message.body || "").trim();
  const text = prefix && body.startsWith(prefix) ? body.slice(prefix.length) : body;
  return (text.split(/\s+/)[0] || "").toLowerCase();
}

/** Remember the bot messages of a game so a reply to any of them counts as an answer */
function trackBotMessage(game, sent) {
  const id = sent?.key?.id;
  if (!id) return;
  if (!game.botMessageId) game.botMessageId = id;
  game.botIds.add(id);
  while (game.botIds.size > MAX_BOT_IDS) {
    game.botIds.delete(game.botIds.values().next().value);
  }
}

function ownsMessage(game, id) {
  return !!id && (game.botMessageId === id || game.botIds.has(id));
}

/** The game's creator, a group admin or an owner may stop or replace a game */
async function canManage(message, game) {
  if (message.sender && message.sender === game.creator) return true;
  if (message.isSudo()) return true;
  return await message.isSenderAdmin();
}

/**
 * Register a new game in `store`; when one is running, only its creator, a group admin
 * or an owner may replace it. Returns the stored game, or null (the player was told).
 */
async function register(message, store, game, busyKey) {
  let res = store.start(message.jid, game);
  if (!res.ok) {
    if (!(await canManage(message, res.existing))) {
      await message.reply(getLang(busyKey, config.PREFIX));
      return null;
    }
    store.end(message.jid);
    res = store.start(message.jid, game);
    if (!res.ok) {
      await message.reply(getLang(busyKey, config.PREFIX));
      return null;
    }
  }
  return res.game;
}

async function stopGame(message, store, noGameKey, stoppedKey, reveal) {
  const game = store.get(message.jid);
  if (!game) return await message.reply(getLang(noGameKey, config.PREFIX));
  if (!(await canManage(message, game))) {
    return await message.reply(getLang("plugins.quiz.stop_denied"));
  }
  store.end(message.jid);
  return await message.reply(getLang(stoppedKey, reveal(game)));
}

// ---------------------------------------------------------------- quiz

async function startQuiz(message) {
  const pool = questionPool();
  const question = pool[Math.floor(Math.random() * pool.length)];

  const game = {
    category: question.category,
    question: question.question,
    display: question.answers[0],
    answers: question.answers.map(normalizeAnswer),
    hints: question.hints,
    hintIndex: 0,
    attempts: 0,
    maxAttempts: QUIZ_MAX_ATTEMPTS,
    creator: message.sender,
    botMessageId: null,
    botIds: new Set(),
  };
  const stored = await register(message, quizStore, game, "plugins.quiz.quiz_already_running");
  if (!stored) return;

  const sent = await message.reply(
    getLang("plugins.quiz.quiz_started", game.category, game.question, config.PREFIX),
  );
  trackBotMessage(stored, sent);
}

async function quizHint(message) {
  const game = quizStore.get(message.jid);
  if (!game) return await message.reply(getLang("plugins.quiz.no_quiz", config.PREFIX));
  if (game.hintIndex >= game.hints.length) {
    return await message.reply(getLang("plugins.quiz.no_hints"));
  }
  const hint = game.hints[game.hintIndex];
  game.hintIndex += 1;
  quizStore.touch(message.jid);
  return await message.reply(
    getLang("plugins.quiz.hint", game.hintIndex, game.hints.length, hint),
  );
}

async function answerQuiz(message, game, text) {
  game.attempts += 1;
  quizStore.touch(message.jid);

  if (game.answers.includes(normalizeAnswer(text))) {
    quizStore.end(message.jid);
    await message.react("🎉");
    return await message.reply(
      getLang("plugins.quiz.quiz_correct", game.display, game.attempts, config.PREFIX),
    );
  }

  if (game.attempts >= game.maxAttempts) {
    quizStore.end(message.jid);
    return await message.reply(
      getLang("plugins.quiz.quiz_failed", game.display, config.PREFIX),
    );
  }

  return await message.reply(
    getLang("plugins.quiz.quiz_wrong", game.maxAttempts - game.attempts),
  );
}

async function handleQuiz(message, action) {
  if (action === "" || action === "start" || action === "new") return await startQuiz(message);
  if (action === "hint") return await quizHint(message);
  if (action === "stop" || action === "quit") {
    return await stopGame(
      message,
      quizStore,
      "plugins.quiz.no_quiz",
      "plugins.quiz.quiz_stopped",
      (game) => game.display,
    );
  }
  return await message.reply(getLang("plugins.quiz.usage", config.PREFIX));
}

// --------------------------------------------------------------- guess

async function startGuess(message) {
  const game = {
    number: Math.floor(Math.random() * GUESS_MAX) + 1,
    attempts: 0,
    maxAttempts: GUESS_MAX_ATTEMPTS,
    creator: message.sender,
    botMessageId: null,
    botIds: new Set(),
  };
  const stored = await register(message, guessStore, game, "plugins.quiz.guess_already_running");
  if (!stored) return;

  const sent = await message.reply(
    getLang("plugins.quiz.guess_started", GUESS_MAX, GUESS_MAX_ATTEMPTS, config.PREFIX),
  );
  trackBotMessage(stored, sent);
}

async function answerGuess(message, game, text) {
  const value = String(text).trim();
  const guess = /^\d{1,6}$/.test(value) ? parseInt(value, 10) : NaN;
  if (!Number.isInteger(guess) || guess < 1 || guess > GUESS_MAX) {
    return await message.reply(getLang("plugins.quiz.invalid_number", GUESS_MAX));
  }

  game.attempts += 1;
  guessStore.touch(message.jid);

  if (guess === game.number) {
    guessStore.end(message.jid);
    await message.react("🎉");
    return await message.reply(
      getLang("plugins.quiz.guess_correct", game.number, game.attempts, config.PREFIX),
    );
  }

  if (game.attempts >= game.maxAttempts) {
    guessStore.end(message.jid);
    return await message.reply(
      getLang("plugins.quiz.guess_failed", game.number, config.PREFIX),
    );
  }

  const direction =
    guess < game.number ? getLang("plugins.quiz.higher") : getLang("plugins.quiz.lower");
  return await message.reply(
    getLang("plugins.quiz.guess_left", direction, game.maxAttempts - game.attempts),
  );
}

async function handleGuess(message, action) {
  if (action === "" || action === "start" || action === "new") return await startGuess(message);
  if (/^\d+$/.test(action)) {
    const game = guessStore.get(message.jid);
    if (!game) return await message.reply(getLang("plugins.quiz.no_guess", config.PREFIX));
    return await answerGuess(message, game, action);
  }
  if (action === "stop" || action === "quit") {
    return await stopGame(
      message,
      guessStore,
      "plugins.quiz.no_guess",
      "plugins.quiz.guess_stopped",
      (game) => game.number,
    );
  }
  return await message.reply(getLang("plugins.quiz.usage", config.PREFIX));
}

module.exports = {
  command: {
    pattern: "quiz|guess",
    desc: getLang("plugins.quiz.desc"),
    type: "fun",
  },

  async execute(message, argsString, ctx) {
    const command = commandOf(message, ctx);
    const raw = String(ctx?.rawArgs ?? argsString ?? "");
    const action = raw.trim().toLowerCase().split(/\s+/)[0] || "";

    if (action === "help") return await message.reply(getLang("plugins.quiz.usage", config.PREFIX));
    if (command === "guess") return await handleGuess(message, action);
    return await handleQuiz(message, action);
  },

  // Replies to a quiz or number-game message count as answers; anything else is not ours
  async handleButtonReply(message) {
    if (!message.quoted || message.fromMe) return false;
    const body = (message.body || "").trim();
    if (!body || body.startsWith(config.PREFIX)) return false;

    const quiz = quizStore.get(message.jid);
    if (quiz && ownsMessage(quiz, message.quoted.id)) {
      try {
        await answerQuiz(message, quiz, body);
      } catch (err) {
        console.error("Quiz answer error:", safeLog(err));
      }
      return true;
    }

    const guess = guessStore.get(message.jid);
    if (guess && ownsMessage(guess, message.quoted.id)) {
      try {
        await answerGuess(message, guess, body);
      } catch (err) {
        console.error("Guess answer error:", safeLog(err));
      }
      return true;
    }

    return false;
  },
};
