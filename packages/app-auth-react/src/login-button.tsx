import React, { useCallback, useRef } from 'react';

import type { SapiomAuth, AuthMessage } from '@sapiom/app-auth';

import { openAuthPopup } from './popup.js';

export interface LoginButtonProps {
  auth: SapiomAuth;
  onLogin: (sessionToken: string, userId: string) => void;
  onError?: (error: string) => void;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}

/**
 * Unstyled button that opens a popup for Auth0 login.
 * Calls onLogin with the session token on success.
 */
export function LoginButton({
  auth,
  onLogin,
  onError,
  children = 'Log in',
  className,
  style,
  disabled,
}: LoginButtonProps) {
  const cleanupRef = useRef<(() => void) | null>(null);

  const handleClick = useCallback(() => {
    // Clean up any existing popup
    cleanupRef.current?.();

    const url = auth.getLoginUrl();

    cleanupRef.current = openAuthPopup({
      url,
      onMessage: (message: AuthMessage) => {
        if (message.type === 'sapiom:auth:login') {
          onLogin(message.sessionToken, message.userId);
        } else if (message.type === 'sapiom:auth:error') {
          onError?.(message.error);
        }
      },
      onError: (err) => onError?.(err.message),
    });
  }, [auth, onLogin, onError]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={className}
      style={style}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
