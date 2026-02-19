import type { AuthMessage } from '@sapiom/app-auth';

export interface PopupOptions {
  url: string;
  onMessage: (message: AuthMessage) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  width?: number;
  height?: number;
}

/**
 * Open a centered popup window and listen for postMessage events.
 * Returns a cleanup function to stop listening.
 */
export function openAuthPopup(options: PopupOptions): () => void {
  const { url, onMessage, onError, onClose, width = 500, height = 600 } = options;

  // Center the popup
  const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - height) / 2);

  const features = `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`;

  const popup = window.open(url, 'sapiom_auth', features);

  if (!popup) {
    onError?.(new Error('Popup was blocked by the browser'));
    return () => {};
  }

  let cleaned = false;

  const expectedOrigin = new URL(url).origin;

  const handleMessage = (event: MessageEvent) => {
    // Verify the message comes from the auth gateway
    if (event.origin !== expectedOrigin) return;

    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    if (!data.type.startsWith('sapiom:auth:')) return;

    onMessage(data as AuthMessage);
    cleanup();
  };

  // Poll for popup close (no reliable close event across browsers)
  const pollInterval = setInterval(() => {
    if (popup.closed) {
      cleanup();
      onClose?.();
    }
  }, 500);

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(pollInterval);
    window.removeEventListener('message', handleMessage);
    if (!popup.closed) {
      popup.close();
    }
  };

  window.addEventListener('message', handleMessage);

  return cleanup;
}
