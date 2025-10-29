const { getLang } = require("../lib/utils/language");
const axios = require("axios");
const config = require("../config");

/**
 * Weather Plugin - Display weather information
 */
module.exports = {
  command: {
    pattern: "weather|meteo|clima",
    desc: getLang("plugins.weather.desc"),
    type: "info",
  },

  async execute(message, query) {
    if (!query) {
      return await message.reply(getLang("plugins.weather.usage"));
    }

    try {
      await message.react("⏳");

      const API_KEY = config.WEATHER_API_KEY || process.env.WEATHER_API_KEY;
      if (!API_KEY) {
        return await message.reply(
          "❌ " + getLang("plugins.weather.no_api_key")
        );
      }

      const response = await axios.get(
        `https://api.weatherapi.com/v1/current.json`,
        {
          params: {
            key: API_KEY,
            q: query,
            aqi: "yes",
          },
          timeout: 10000,
        }
      );

      const data = response.data;
      
      const weatherIcons = {
        "Clear": "☀️",
        "Sunny": "☀️",
        "Partly cloudy": "⛅",
        "Cloudy": "☁️",
        "Overcast": "☁️",
        "Mist": "🌫️",
        "Fog": "🌫️",
        "Rain": "🌧️",
        "Light rain": "🌦️",
        "Heavy rain": "⛈️",
        "Snow": "❄️",
        "Thunderstorm": "⛈️",
      };

      const conditionText = data.current.condition.text;
      const icon = weatherIcons[conditionText] || "🌤️";

      const result = `${icon} *${getLang("plugins.weather.title")} - ${data.location.name}*\n\n` +
        `📍 *${getLang("plugins.weather.location")}:* ${data.location.name}, ${data.location.region}, ${data.location.country}\n` +
        `🌡️ *${getLang("plugins.weather.temperature")}:* ${data.current.temp_c}°C (${data.current.temp_f}°F)\n` +
        `🌡️ *${getLang("plugins.weather.feels_like")}:* ${data.current.feelslike_c}°C (${data.current.feelslike_f}°F)\n` +
        `☁️ *${getLang("plugins.weather.condition")}:* ${conditionText}\n` +
        `💨 *${getLang("plugins.weather.wind")}:* ${data.current.wind_kph} km/h (${data.current.wind_mph} mph) ${data.current.wind_dir}\n` +
        `💧 *${getLang("plugins.weather.humidity")}:* ${data.current.humidity}%\n` +
        `🌡️ *${getLang("plugins.weather.pressure")}:* ${data.current.pressure_mb} mb\n` +
        `👁️ *${getLang("plugins.weather.visibility")}:* ${data.current.vis_km} km\n` +
        `☀️ *${getLang("plugins.weather.uv_index")}:* ${data.current.uv}\n\n` +
        `🕐 *${getLang("plugins.weather.last_update")}:* ${data.current.last_updated}`;

      await message.react("✅");
      await message.reply(result);

    } catch (error) {
      await message.react("❌");
      console.error("Weather error:", error);
      
      if (error.response && error.response.status === 400) {
        await message.reply(`❌ ${getLang("plugins.weather.location_not_found")}`);
      } else {
        await message.reply(`❌ ${getLang("plugins.weather.error")}: ${error.message}`);
      }
    }
  },
};
