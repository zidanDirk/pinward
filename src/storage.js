const KEY = "pinward.v1";
export const defaultProfile = () => ({
  stars: 0,
  slots: 2,
  choiceUnlocked: false,
  best: 0,
  bestWave: 0,
  runs: [],
  muted: false,
});
export function readProfile(storage) {
  try {
    const raw = JSON.parse(storage.getItem(KEY));
    if (!raw || typeof raw !== "object") return defaultProfile();
    const number = (v, min, max, fallback) =>
      Number.isFinite(v)
        ? Math.max(min, Math.min(max, Math.floor(v)))
        : fallback;
    return {
      stars: number(raw.stars, 0, 9999999, 0),
      slots: number(raw.slots, 2, 4, 2),
      choiceUnlocked: raw.choiceUnlocked === true,
      best: number(raw.best, 0, 999999999, 0),
      bestWave: number(raw.bestWave, 0, 13, 0),
      muted: raw.muted === true,
      runs: Array.isArray(raw.runs)
        ? raw.runs
            .filter(
              (r) =>
                r &&
                Number.isFinite(r.score) &&
                Number.isFinite(r.wave) &&
                typeof r.style === "string",
            )
            .slice(0, 5)
        : [],
    };
  } catch {
    return defaultProfile();
  }
}
export function saveProfile(profile, storage) {
  try {
    storage.setItem(KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}
export function recordRun(profile, game) {
  const earned = Math.max(1, Math.floor(game.score / 800) + (game.won ? 8 : 0));
  const counts = {};
  for (const b of game.bumpers) counts[b.type] = (counts[b.type] || 0) + 1;
  const style =
    Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "standard";
  const run = {
    score: Math.floor(game.score),
    wave: game.wave,
    hp: game.hp,
    won: game.won,
    style,
    date: new Date().toISOString(),
  };
  profile.stars += earned;
  profile.best = Math.max(profile.best, run.score);
  profile.bestWave = Math.max(profile.bestWave, run.wave);
  profile.runs = [...profile.runs, run]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return earned;
}
export function buyUpgrade(profile, kind) {
  if (kind === "slots") {
    const cost = profile.slots === 2 ? 12 : 24;
    if (profile.slots >= 4 || profile.stars < cost) return false;
    profile.stars -= cost;
    profile.slots++;
    return true;
  }
  if (kind === "choice" && !profile.choiceUnlocked && profile.stars >= 16) {
    profile.stars -= 16;
    profile.choiceUnlocked = true;
    return true;
  }
  return false;
}
