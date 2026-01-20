'use client';

/**
 * Get Telegram Web App init data
 */
export function getTelegramInitData(): string | null {
  if (typeof window === 'undefined') return null;

  const tg = (window as any).Telegram?.WebApp;
  return tg?.initData || null;
}

/**
 * Get Telegram user from init data
 */
export function getTelegramUser(): { id: number; firstName: string } | null {
  if (typeof window === 'undefined') return null;

  const tg = (window as any).Telegram?.WebApp;
  const user = tg?.initDataUnsafe?.user;

  if (!user) return null;

  return {
    id: user.id,
    firstName: user.first_name,
  };
}

/**
 * Close the Mini App
 */
export function closeMiniApp(): void {
  if (typeof window === 'undefined') return;

  const tg = (window as any).Telegram?.WebApp;
  tg?.close();
}

/**
 * Expand the Mini App to full height
 */
export function expandMiniApp(): void {
  if (typeof window === 'undefined') return;

  const tg = (window as any).Telegram?.WebApp;
  tg?.expand();
}

/**
 * Show main button
 */
export function showMainButton(text: string, onClick: () => void): void {
  if (typeof window === 'undefined') return;

  const tg = (window as any).Telegram?.WebApp;
  if (!tg?.MainButton) return;

  tg.MainButton.setText(text);
  tg.MainButton.onClick(onClick);
  tg.MainButton.show();
}

/**
 * Hide main button
 */
export function hideMainButton(): void {
  if (typeof window === 'undefined') return;

  const tg = (window as any).Telegram?.WebApp;
  tg?.MainButton?.hide();
}

/**
 * Show loading state on main button
 */
export function setMainButtonLoading(loading: boolean): void {
  if (typeof window === 'undefined') return;

  const tg = (window as any).Telegram?.WebApp;
  if (!tg?.MainButton) return;

  if (loading) {
    tg.MainButton.showProgress();
  } else {
    tg.MainButton.hideProgress();
  }
}

