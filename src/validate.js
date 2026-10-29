export const USERNAME = /^[A-Za-z0-9._@+-]{1,64}$/;
export const EMAIL = /^[^\s@]+@[^\s@]+$/;
export const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function passwordProblem(password) {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 1024) return 'Password is too long.';
  return null;
}
