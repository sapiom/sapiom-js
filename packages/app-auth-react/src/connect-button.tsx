import React, { useCallback, useRef } from 'react';

import type { SapiomAuth, AuthMessage } from '@sapiom/app-auth';

import { openAuthPopup } from './popup.js';

export interface ConnectButtonProps {
  auth: SapiomAuth;
  service: string;
  sessionToken: string;
  scopes?: string[];
  onConnect: (service: string) => void;
  onError?: (error: string) => void;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}

/**
 * Unstyled button that opens a popup for connecting an OAuth service.
 * Calls onConnect with the service name on success.
 */
export function ConnectButton({
  auth,
  service,
  sessionToken,
  scopes,
  onConnect,
  onError,
  children,
  className,
  style,
  disabled,
}: ConnectButtonProps) {
  const cleanupRef = useRef<(() => void) | null>(null);

  const handleClick = useCallback(() => {
    // Clean up any existing popup
    cleanupRef.current?.();

    const url = auth.getConnectUrl(service, sessionToken, scopes);

    cleanupRef.current = openAuthPopup({
      url,
      onMessage: (message: AuthMessage) => {
        if (message.type === 'sapiom:auth:connect') {
          onConnect(message.service);
        } else if (message.type === 'sapiom:auth:error') {
          onError?.(message.error);
        }
      },
      onError: (err) => onError?.(err.message),
    });
  }, [auth, service, sessionToken, scopes, onConnect, onError]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={className}
      style={style}
      disabled={disabled}
    >
      {children ?? `Connect ${service}`}
    </button>
  );
}
