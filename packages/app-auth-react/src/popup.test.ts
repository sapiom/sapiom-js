import { openAuthPopup } from './popup';

describe('openAuthPopup', () => {
  let mockPopup: { closed: boolean; close: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    mockPopup = { closed: false, close: jest.fn() };

    // Mock window.open
    (global as any).window = {
      open: jest.fn().mockReturnValue(mockPopup),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      screenX: 0,
      screenY: 0,
      outerWidth: 1024,
      outerHeight: 768,
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete (global as any).window;
  });

  it('opens a popup with correct URL', () => {
    openAuthPopup({
      url: 'https://example.com/auth/login',
      onMessage: jest.fn(),
    });

    expect(window.open).toHaveBeenCalledWith(
      'https://example.com/auth/login',
      'sapiom_auth',
      expect.stringContaining('width=500'),
    );
  });

  it('adds message event listener', () => {
    openAuthPopup({
      url: 'https://example.com/auth/login',
      onMessage: jest.fn(),
    });

    expect(window.addEventListener).toHaveBeenCalledWith(
      'message',
      expect.any(Function),
    );
  });

  it('calls onError when popup is blocked', () => {
    (window.open as jest.Mock).mockReturnValue(null);
    const onError = jest.fn();

    openAuthPopup({
      url: 'https://example.com/auth/login',
      onMessage: jest.fn(),
      onError,
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('blocked') }),
    );
  });

  it('cleanup function removes listener and closes popup', () => {
    const cleanup = openAuthPopup({
      url: 'https://example.com/auth/login',
      onMessage: jest.fn(),
    });

    cleanup();

    expect(window.removeEventListener).toHaveBeenCalledWith(
      'message',
      expect.any(Function),
    );
    expect(mockPopup.close).toHaveBeenCalled();
  });

  it('accepts messages from the correct origin', () => {
    const onMessage = jest.fn();
    openAuthPopup({
      url: 'https://example.com/auth/login',
      onMessage,
    });

    const handler = (window.addEventListener as jest.Mock).mock.calls[0][1];

    handler({
      origin: 'https://example.com',
      data: { type: 'sapiom:auth:login', sessionToken: 'tok', userId: 'uid' },
    });
    expect(onMessage).toHaveBeenCalledWith({
      type: 'sapiom:auth:login',
      sessionToken: 'tok',
      userId: 'uid',
    });
  });

  it('rejects messages from a different origin', () => {
    const onMessage = jest.fn();
    openAuthPopup({
      url: 'https://example.com/auth/login',
      onMessage,
    });

    const handler = (window.addEventListener as jest.Mock).mock.calls[0][1];

    handler({
      origin: 'https://evil.com',
      data: { type: 'sapiom:auth:login', sessionToken: 'tok', userId: 'uid' },
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('filters messages by sapiom:auth: prefix', () => {
    const onMessage = jest.fn();
    openAuthPopup({
      url: 'https://example.com/auth/login',
      onMessage,
    });

    const handler = (window.addEventListener as jest.Mock).mock.calls[0][1];

    // Non-sapiom message should be ignored
    handler({ origin: 'https://example.com', data: { type: 'other:message' } });
    expect(onMessage).not.toHaveBeenCalled();

    // Sapiom message should be forwarded
    handler({
      origin: 'https://example.com',
      data: { type: 'sapiom:auth:login', sessionToken: 'tok', userId: 'uid' },
    });
    expect(onMessage).toHaveBeenCalledWith({
      type: 'sapiom:auth:login',
      sessionToken: 'tok',
      userId: 'uid',
    });
  });

  it('ignores non-object messages', () => {
    const onMessage = jest.fn();
    openAuthPopup({
      url: 'https://example.com/auth/login',
      onMessage,
    });

    const handler = (window.addEventListener as jest.Mock).mock.calls[0][1];

    handler({ origin: 'https://example.com', data: null });
    handler({ origin: 'https://example.com', data: 'string' });
    handler({ origin: 'https://example.com', data: 42 });

    expect(onMessage).not.toHaveBeenCalled();
  });
});
