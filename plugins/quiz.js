const { getLang } = require("../lib/utils/language");

/**
 * Quiz & Interactive Games Plugin
 */

// Game state storage
const quizGames = new Map(); // chatId -> {question, answer, hints, attempts}
const guessGames = new Map(); // chatId -> {number, attempts, maxAttempts}

// Quiz questions database
const quizQuestions = [
  {
    question: "What is the capital of France?",
    answer: "Paris",
    hints: ["It's a city", "Known for the Eiffel Tower", "Starts with P"],
    category: "Geography"
  },
  {
    question: "What is 15 × 8?",
    answer: "120",
    hints: ["It's a number", "Between 100 and 150", "Divisible by 10"],
    category: "Math"
  },
  {
    question: "Who painted the Mona Lisa?",
    answer: "Leonardo da Vinci",
    hints: ["Italian artist", "Renaissance period", "Also invented flying machines"],
    category: "Art"
  },
  {
    question: "What is the largest planet in our solar system?",
    answer: "Jupiter",
    hints: ["Gas giant", "Named after Roman god", "Has the Great Red Spot"],
    category: "Science"
  },
  {
    question: "In which year did World War II end?",
    answer: "1945",
    hints: ["20th century", "Between 1940 and 1950", "After atomic bombs"],
    category: "History"
  },
];

module.exports = {
  command: {
    pattern: "quiz|trivia|guess|game",
    desc: getLang("plugins.quiz.desc"),
    type: "fun",
  },

  async execute(message, query) {
    const chatId = message.jid;
    const command = message.body.split(" ")[0].replace(require("../config").PREFIX, "");

    try {
      if (command === "quiz" || command === "trivia") {
        return await handleQuiz(message, query, chatId);
      } else if (command === "guess" || command === "game") {
        return await handleGuess(message, query, chatId);
      }
    } catch (error) {
      await message.react("❌");
      console.error("Quiz/Game error:", error);
      await message.reply(`❌ ${getLang("plugins.quiz.error")}: ${error.message}`);
    }
  },
};

async function handleQuiz(message, query, chatId) {
  const action = query.toLowerCase();

  if (action === "start") {
    // Select random question
    const question = quizQuestions[Math.floor(Math.random() * quizQuestions.length)];
    
    quizGames.set(chatId, {
      question: question.question,
      answer: question.answer.toLowerCase(),
      hints: question.hints,
      category: question.category,
      attempts: 0,
      maxAttempts: 3,
      hintIndex: 0,
    });

    return await message.reply(
      `🎯 *${getLang("plugins.quiz.started")}*\n\n` +
      `📚 *${getLang("plugins.quiz.category")}:* ${question.category}\n\n` +
      `❓ *${getLang("plugins.quiz.question")}*\n${question.question}\n\n` +
      `💡 _${getLang("plugins.quiz.hint_info")}_\n` +
      `📝 _${getLang("plugins.quiz.answer_info")}_`
    );
  }

  if (action === "stop" || action === "quit") {
    if (!quizGames.has(chatId)) {
      return await message.reply(`❌ ${getLang("plugins.quiz.no_game")}`);
    }

    const game = quizGames.get(chatId);
    quizGames.delete(chatId);
    return await message.reply(
      `🛑 ${getLang("plugins.quiz.stopped")}\n\n` +
      `✅ ${getLang("plugins.quiz.correct_answer")}: *${game.answer}*`
    );
  }

  if (action === "hint") {
    const game = quizGames.get(chatId);
    if (!game) {
      return await message.reply(`❌ ${getLang("plugins.quiz.no_game")}`);
    }

    if (game.hintIndex >= game.hints.length) {
      return await message.reply(`❌ ${getLang("plugins.quiz.no_hints")}`);
    }

    const hint = game.hints[game.hintIndex];
    game.hintIndex++;

    return await message.reply(`💡 *${getLang("plugins.quiz.hint")} ${game.hintIndex}:* ${hint}`);
  }

  // Check if answering
  const game = quizGames.get(chatId);
  if (game && query) {
    game.attempts++;
    
    if (query.toLowerCase() === game.answer) {
      quizGames.delete(chatId);
      await message.react("🎉");
      return await message.reply(
        `🎉 *${getLang("plugins.quiz.correct")}!*\n\n` +
        `✅ ${getLang("plugins.quiz.answer")}: ${game.answer}\n` +
        `🎯 ${getLang("plugins.quiz.attempts")}: ${game.attempts}\n\n` +
        `_${getLang("plugins.quiz.new_game")}_`
      );
    }

    if (game.attempts >= game.maxAttempts) {
      const correctAnswer = game.answer;
      quizGames.delete(chatId);
      return await message.reply(
        `❌ *${getLang("plugins.quiz.failed")}*\n\n` +
        `✅ ${getLang("plugins.quiz.correct_answer")}: *${correctAnswer}*\n\n` +
        `_${getLang("plugins.quiz.try_again")}_`
      );
    }

    return await message.reply(
      `❌ ${getLang("plugins.quiz.wrong")}\n` +
      `📊 ${getLang("plugins.quiz.attempts_left")}: ${game.maxAttempts - game.attempts}`
    );
  }

  // Show help
  await message.reply(getLang("plugins.quiz.usage"));
}

async function handleGuess(message, query, chatId) {
  const action = query.toLowerCase();

  if (action === "start") {
    const randomNumber = Math.floor(Math.random() * 100) + 1;
    guessGames.set(chatId, {
      number: randomNumber,
      attempts: 0,
      maxAttempts: 10,
    });

    return await message.reply(
      `🎮 *${getLang("plugins.quiz.guess_started")}*\n\n` +
      `🔢 ${getLang("plugins.quiz.guess_info")}\n` +
      `🎯 ${getLang("plugins.quiz.guess_attempts")}: 10\n\n` +
      `_${getLang("plugins.quiz.guess_example")}_`
    );
  }

  if (action === "stop") {
    if (!guessGames.has(chatId)) {
      return await message.reply(`❌ ${getLang("plugins.quiz.no_game")}`);
    }

    const game = guessGames.get(chatId);
    guessGames.delete(chatId);
    return await message.reply(
      `🛑 ${getLang("plugins.quiz.stopped")}\n` +
      `🔢 ${getLang("plugins.quiz.number_was")}: *${game.number}*`
    );
  }

  // Check if guessing
  const game = guessGames.get(chatId);
  if (game && query) {
    const guess = parseInt(query);
    
    if (isNaN(guess) || guess < 1 || guess > 100) {
      return await message.reply(`❌ ${getLang("plugins.quiz.invalid_number")}`);
    }

    game.attempts++;

    if (guess === game.number) {
      guessGames.delete(chatId);
      await message.react("🎉");
      return await message.reply(
        `🎉 *${getLang("plugins.quiz.guess_correct")}!*\n\n` +
        `🔢 ${getLang("plugins.quiz.number")}: ${game.number}\n` +
        `🎯 ${getLang("plugins.quiz.attempts")}: ${game.attempts}\n\n` +
        `_${getLang("plugins.quiz.new_game")}_`
      );
    }

    if (game.attempts >= game.maxAttempts) {
      const number = game.number;
      guessGames.delete(chatId);
      return await message.reply(
        `😔 *${getLang("plugins.quiz.guess_failed")}*\n\n` +
        `🔢 ${getLang("plugins.quiz.number_was")}: *${number}*\n\n` +
        `_${getLang("plugins.quiz.try_again")}_`
      );
    }

    const hint = guess < game.number ? "⬆️ " + getLang("plugins.quiz.higher") : "⬇️ " + getLang("plugins.quiz.lower");
    const remaining = game.maxAttempts - game.attempts;

    return await message.reply(
      `${hint}\n` +
      `📊 ${getLang("plugins.quiz.attempts_left")}: ${remaining}`
    );
  }

  // Show help
  await message.reply(getLang("plugins.quiz.guess_usage"));
}
