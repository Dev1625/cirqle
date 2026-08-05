export function readPositiveKilobyteBudget(
  env,
  name,
  defaultKilobytes,
) {
  const raw = env[name];
  const value =
    raw === undefined ? defaultKilobytes : Number(raw);
  const bytes = value * 1024;

  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isFinite(bytes)
  ) {
    throw new Error(
      `${name} must be a finite positive number of kilobytes.`,
    );
  }

  return bytes;
}
