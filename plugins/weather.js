const { getLang } = require("../lib/utils/language");
const { fetchJson, classifyError, replyKeyFor, safeLog } = require("../lib/utils/http");
const config = require("../config");

/**
 * Weather Plugin - current weather for a city
 *   .weather <city>   (alias .meteo)
 * WeatherAPI when WEATHER_API_KEY is set (text in config.LANG), otherwise, or when
 * WeatherAPI fails, the keyless Open-Meteo service.
 */

const TIMEOUT_MS = 10000;
const MAX_QUERY_LENGTH = 100;

class LocationNotFoundError extends Error {
  constructor() {
    super("Location not found");
    this.name = "LocationNotFoundError";
  }
}

const botLang = () => (config.LANG || "en").slice(0, 2);

/** WeatherAPI condition code → emoji (https://www.weatherapi.com/docs/weather_conditions.json) */
function weatherApiIcon(code, isDay) {
  if (code === 1000) return isDay ? "☀️" : "🌙";
  if (code === 1003) return isDay ? "⛅" : "☁️";
  if ([1006, 1009].includes(code)) return "☁️";
  if ([1030, 1135, 1147].includes(code)) return "🌫️";
  if ([1087, 1273, 1276, 1279, 1282].includes(code)) return "⛈️";
  if ([1063, 1150, 1153, 1180, 1183, 1240].includes(code)) return "🌦️";
  if ([1186, 1189, 1192, 1195, 1243, 1246].includes(code)) return "🌧️";
  if ([1069, 1072, 1168, 1171, 1198, 1201, 1204, 1207, 1237, 1249, 1252].includes(code)) return "🌨️";
  if ([1066, 1114, 1117, 1210, 1213, 1216, 1219, 1222, 1225, 1255, 1258, 1261, 1264].includes(code)) return "❄️";
  return "🌤️";
}

/** WMO weather code (Open-Meteo) → localized text key + emoji */
function wmoCondition(code, isDay) {
  const sun = isDay ? "☀️" : "🌙";
  if (code === 0) return { key: "clear", icon: sun };
  if (code === 1) return { key: "mainly_clear", icon: isDay ? "🌤️" : "🌙" };
  if (code === 2) return { key: "partly_cloudy", icon: isDay ? "⛅" : "☁️" };
  if (code === 3) return { key: "overcast", icon: "☁️" };
  if (code === 45 || code === 48) return { key: "fog", icon: "🌫️" };
  if ([51, 53, 55].includes(code)) return { key: "drizzle", icon: "🌦️" };
  if (code === 56 || code === 57) return { key: "freezing_drizzle", icon: "🌨️" };
  if ([61, 63, 65].includes(code)) return { key: "rain", icon: "🌧️" };
  if (code === 66 || code === 67) return { key: "freezing_rain", icon: "🌨️" };
  if ([71, 73, 75].includes(code)) return { key: "snow", icon: "❄️" };
  if (code === 77) return { key: "snow_grains", icon: "❄️" };
  if ([80, 81, 82].includes(code)) return { key: "rain_showers", icon: "🌦️" };
  if (code === 85 || code === 86) return { key: "snow_showers", icon: "🌨️" };
  if (code === 95) return { key: "thunderstorm", icon: "⛈️" };
  if (code === 96 || code === 99) return { key: "thunderstorm_hail", icon: "⛈️" };
  return { key: "unknown", icon: "🌤️" };
}

const toFahrenheit = (c) => Math.round(((c * 9) / 5 + 32) * 10) / 10;
const toMph = (kph) => Math.round(kph * 0.621371 * 10) / 10;
const num = (value) => (Number.isFinite(value) ? value : null);

async function fromWeatherApi(city) {
  let data;
  try {
    data = await fetchJson("https://api.weatherapi.com/v1/current.json", {
      params: { key: config.WEATHER_API_KEY, q: city, lang: botLang(), aqi: "no" },
      timeoutMs: TIMEOUT_MS,
    });
  } catch (error) {
    // 1006 = "No matching location found"
    if (error?.response?.data?.error?.code === 1006) throw new LocationNotFoundError();
    throw error;
  }

  const { location, current } = data || {};
  if (!location || !current) throw new Error("Unexpected WeatherAPI response");

  return {
    name: location.name,
    place: [location.name, location.region, location.country].filter(Boolean).join(", "),
    icon: weatherApiIcon(current.condition?.code, current.is_day === 1),
    condition: current.condition?.text,
    tempC: num(current.temp_c),
    feelsC: num(current.feelslike_c),
    windKph: num(current.wind_kph),
    windDir: current.wind_dir,
    humidity: num(current.humidity),
    pressure: num(current.pressure_mb),
    visibilityKm: num(current.vis_km),
    uv: num(current.uv),
    updated: current.last_updated,
  };
}

async function fromOpenMeteo(city) {
  const geo = await fetchJson("https://geocoding-api.open-meteo.com/v1/search", {
    params: { name: city, count: 1, language: botLang() },
    timeoutMs: TIMEOUT_MS,
  });
  const place = geo?.results?.[0];
  if (!place) throw new LocationNotFoundError();

  const data = await fetchJson("https://api.open-meteo.com/v1/forecast", {
    params: {
      latitude: place.latitude,
      longitude: place.longitude,
      current:
        "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day,surface_pressure",
      timezone: "auto",
    },
    timeoutMs: TIMEOUT_MS,
  });
  const current = data?.current;
  if (!current) throw new Error("Unexpected Open-Meteo response");

  const wmo = wmoCondition(current.weather_code, current.is_day !== 0);
  return {
    name: place.name,
    place: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
    icon: wmo.icon,
    condition: getLang(`plugins.weather.wmo_${wmo.key}`),
    tempC: num(current.temperature_2m),
    feelsC: num(current.apparent_temperature),
    windKph: num(current.wind_speed_10m),
    humidity: num(current.relative_humidity_2m),
    pressure: num(current.surface_pressure),
    // Open-Meteo gives local time as "2026-10-27T22:45"
    updated: typeof current.time === "string" ? current.time.replace("T", " ") : undefined,
  };
}

/** Build the reply, skipping the fields the service did not send */
function formatWeather(w) {
  const field = (emoji, labelKey, value) =>
    value === null || value === undefined || value === ""
      ? null
      : `${emoji} *${getLang(labelKey)}:* ${value}`;

  const lines = [
    `${w.icon} ${getLang("plugins.weather.title", w.name)}`,
    "",
    field("📍", "plugins.weather.location", w.place),
    field(
      "🌡️",
      "plugins.weather.temperature",
      w.tempC === null ? null : `${w.tempC}°C (${toFahrenheit(w.tempC)}°F)`,
    ),
    field(
      "🌡️",
      "plugins.weather.feels_like",
      w.feelsC === null ? null : `${w.feelsC}°C (${toFahrenheit(w.feelsC)}°F)`,
    ),
    field("☁️", "plugins.weather.condition", w.condition),
    field(
      "💨",
      "plugins.weather.wind",
      w.windKph === null
        ? null
        : `${w.windKph} km/h (${toMph(w.windKph)} mph)${w.windDir ? ` ${w.windDir}` : ""}`,
    ),
    field("💧", "plugins.weather.humidity", w.humidity === null ? null : `${w.humidity}%`),
    field("🌡️", "plugins.weather.pressure", w.pressure === null ? null : `${w.pressure} hPa`),
    field(
      "👁️",
      "plugins.weather.visibility",
      w.visibilityKm === null || w.visibilityKm === undefined ? null : `${w.visibilityKm} km`,
    ),
    field("☀️", "plugins.weather.uv_index", w.uv === null || w.uv === undefined ? null : w.uv),
    "",
    field("🕐", "plugins.weather.last_update", w.updated),
  ];
  return lines.filter((line) => line !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = {
  command: {
    pattern: "weather|meteo",
    desc: getLang("plugins.weather.desc"),
    type: "info",
  },

  async execute(message, query, ctx) {
    const city = (ctx?.rawArgs ?? query ?? "").replace(/\s+/g, " ").trim();
    if (!city) {
      return await message.reply(getLang("plugins.weather.usage", config.PREFIX));
    }
    if (city.length > MAX_QUERY_LENGTH) {
      return await message.reply(getLang("plugins.weather.location_not_found"));
    }

    try {
      await message.react("⏳");

      let weather = null;
      let firstError = null;
      if (config.WEATHER_API_KEY) {
        try {
          weather = await fromWeatherApi(city);
        } catch (error) {
          if (error instanceof LocationNotFoundError) throw error;
          // key refused, quota used up, service down...: try the keyless service
          firstError = error;
          console.warn("WeatherAPI failed:", safeLog(error));
        }
      }
      if (!weather) {
        try {
          weather = await fromOpenMeteo(city);
        } catch (error) {
          if (error instanceof LocationNotFoundError) throw error;
          throw firstError || error;
        }
      }

      await message.react("✅");
      await message.reply(formatWeather(weather));
    } catch (error) {
      await message.react("❌");
      if (error instanceof LocationNotFoundError) {
        return await message.reply(getLang("plugins.weather.location_not_found"));
      }
      console.error("Weather error:", safeLog(error));
      await message.reply(
        getLang(replyKeyFor(classifyError(error, { hasKey: !!config.WEATHER_API_KEY }))),
      );
    }
  },
};
