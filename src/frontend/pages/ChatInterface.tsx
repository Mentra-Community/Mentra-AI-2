import React, { useState, useEffect, useRef, memo } from 'react';
import { X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Lottie from 'lottie-react';
import Markdown from 'react-markdown';
// @ts-ignore - JSON import
import MentraLogoAnimation from '../../public/figma-parth-assets/anim/Mentralogo2.json';
import { MiraBackgroundAnimation } from '../components/MiraBackgroundAnimation';
// @ts-ignore - SVG import
import ColorMiraLogo from '../../public/figma-parth-assets/icons/color-mira-logo.svg';
import Settings from './Settings';
import Header from '../components/Header';
import BottomHeader from '../components/BottomHeader';
import { fetchUserSettings } from '../api/settings.api';

interface Message {
  id: string;
  senderId: string;
  recipientId: string;
  content: string;
  timestamp: Date;
  image?: string;
}

interface ChatInterfaceProps {
  userId: string;
  recipientId: string;
}

/**
 * Memoized message bubble
 */
const ChatBubble = memo(function ChatBubble({
  message,
  isOwnMessage,
  index,
}: {
  message: Message;
  isOwnMessage: boolean;
  index: number;
}) {
  return (
    <motion.div
      key={message.id}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
      className={`flex flex-col gap-2 ${isOwnMessage ? 'items-end' : 'items-start'}`}
    >
      {/* Avatar and Name */}
      <div className={`flex items-center gap-2 ${isOwnMessage ? 'flex-row-reverse' : 'flex-row'}`}>
        <div className="ml-[8px]">
          {!isOwnMessage && (
            <img src={ColorMiraLogo} alt="Mentra" className="w-[40px] h-[40px]" />
          )}
        </div>
      </div>

      {/* Message Content */}
      <div className={`flex flex-col ${isOwnMessage ? 'items-end' : 'items-start'}`}>
        {message.image && (
          <div className="mb-2">
            <img
              src={message.image}
              alt="Message context"
              className="rounded-[8px] max-w-xs h-auto cursor-zoom-in hover:opacity-90 transition-opacity"
              style={{ maxWidth: '200px' }}
            />
          </div>
        )}
        <div
          className={`text-[var(--foreground)] leading-relaxed whitespace-pre-line pt-[8px] pb-[8px] pr-[16px] pl-[16px] rounded-[16px] inline-block max-w-[85vw] sm:max-w-lg text-[16px] ${
            isOwnMessage
              ? 'bg-[var(--primary-foreground)] font-medium text-[var(--secondary-foreground:)]'
              : 'bg-transparent pl-0 font-medium *:text-[var(--secondary-foreground:)]'
          }`}
          style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
        >
          {isOwnMessage ? (
            message.content
          ) : (
            <Markdown
              components={{
                p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                strong: ({ children }) => <strong className="font-bold">{children}</strong>,
                em: ({ children }) => <em className="italic">{children}</em>,
                ul: ({ children }) => <ul className="list-disc pl-4 mb-2">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-4 mb-2">{children}</ol>,
                li: ({ children }) => <li className="mb-1">{children}</li>,
                code: ({ children, className }) => {
                  const isBlock = className?.includes('language-');
                  return isBlock ? (
                    <pre className="bg-[var(--primary-foreground)] rounded-lg p-3 my-2 overflow-x-auto">
                      <code className="text-[14px] font-mono">{children}</code>
                    </pre>
                  ) : (
                    <code className="bg-[var(--primary-foreground)] rounded px-1.5 py-0.5 text-[14px] font-mono">
                      {children}
                    </code>
                  );
                },
                h1: ({ children }) => <h1 className="text-xl font-bold mb-2">{children}</h1>,
                h2: ({ children }) => <h2 className="text-lg font-bold mb-2">{children}</h2>,
                h3: ({ children }) => <h3 className="text-base font-bold mb-1">{children}</h3>,
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-gray-400 pl-3 italic my-2">
                    {children}
                  </blockquote>
                ),
              }}
            >
              {message.content}
            </Markdown>
          )}
        </div>
        <div
          className={`text-[12px] ml-[15px] mt-1.5 ${isOwnMessage ? 'text-right' : 'text-left'} w-full text-gray-400`}
        >
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </motion.div>
  );
});

/**
 * ChatInterface component - Beautiful dark-themed chat UI
 */
function ChatInterface({ userId, recipientId }: ChatInterfaceProps) {
  const thinkingWords = [
    'doodling',
    'vibing',
    'cooking',
    'pondering',
    'brewing',
    'crafting',
    'dreaming',
    'computing',
    'processing',
    'brainstorming',
    'conjuring',
    'imagining',
  ];

  const [messages, setMessages] = useState<Message[]>([]);
  const [hasConnectedBefore] = useState(() => {
    return sessionStorage.getItem('mentra-session-connected') === 'true';
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [thinkingWord, setThinkingWord] = useState(() =>
    thinkingWords[Math.floor(Math.random() * thinkingWords.length)]
  );
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const [imageScale, setImageScale] = useState(1);
  const [imagePosition, setImagePosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('mentra-dark-mode');
    return saved ? JSON.parse(saved) : false;
  });
  const [chatHistoryEnabled, setChatHistoryEnabled] = useState(false);
  const [currentPage, setCurrentPage] = useState<'chat' | 'settings'>('chat');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);

  // Scroll to bottom of messages
  const scrollToBottom = (instant?: boolean) => {
    setTimeout(() => {
      const container = messagesEndRef.current?.parentElement?.parentElement?.parentElement;
      if (container && messagesEndRef.current) {
        const targetPosition = messagesEndRef.current.offsetTop + 150;
        container.scrollTo({ top: targetPosition, behavior: instant ? 'instant' : 'smooth' });
      }
    }, instant ? 0 : 100);
  };

  const hasScrolledOnReconnect = useRef(false);
  useEffect(() => {
    if (hasConnectedBefore && !hasScrolledOnReconnect.current && messages.length > 0) {
      hasScrolledOnReconnect.current = true;
      scrollToBottom(true);
    } else {
      scrollToBottom();
    }
  }, [messages, hasConnectedBefore]);

  useEffect(() => {
    if (currentPage === 'chat' && messages.length > 0) {
      scrollToBottom();
    }
  }, [currentPage, messages.length]);

  // Save dark mode preference
  useEffect(() => {
    localStorage.setItem('mentra-dark-mode', JSON.stringify(isDarkMode));
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  // Load user settings on mount
  useEffect(() => {
    if (userId) {
      fetchUserSettings(userId)
        .then((settings) => {
          setChatHistoryEnabled(settings.chatHistoryEnabled ?? false);
        })
        .catch((error) => {
          console.error('[ChatInterface] Failed to fetch user settings:', error);
        });
    }
  }, [userId]);

  // Set up SSE connection for real-time updates
  useEffect(() => {
    if (!userId || !recipientId) {
      return;
    }

    const sseUrl = `/api/chat/stream?userId=${encodeURIComponent(userId)}&recipientId=${encodeURIComponent(recipientId)}`;
    const eventSource = new EventSource(sseUrl);
    sseRef.current = eventSource;

    eventSource.onopen = () => {
      sessionStorage.setItem('mentra-session-connected', 'true');
    };

    eventSource.onmessage = (event) => {
      if (!event.data || event.data.trim() === '') {
        return;
      }

      try {
        const data = JSON.parse(event.data);

        if (data.type === 'message') {
          const isRelevant =
            (data.senderId === userId && data.recipientId === recipientId) ||
            (data.senderId === recipientId && data.recipientId === userId);

          if (isRelevant) {
            if (data.senderId === userId) {
              const randomWord = thinkingWords[Math.floor(Math.random() * thinkingWords.length)];
              setThinkingWord(randomWord);
              setIsProcessing(true);
            } else {
              setIsProcessing(false);
            }

            setMessages((prev) => [
              ...prev,
              {
                id: data.id || Date.now().toString(),
                senderId: data.senderId,
                recipientId: data.recipientId,
                content: data.content,
                timestamp: new Date(data.timestamp),
                image: data.image,
              },
            ]);
          }
        } else if (data.type === 'processing') {
          const randomWord = thinkingWords[Math.floor(Math.random() * thinkingWords.length)];
          setThinkingWord(randomWord);
          setIsProcessing(true);
        } else if (data.type === 'idle') {
          setIsProcessing(false);
        } else if (data.type === 'history') {
          setMessages(
            data.messages.map((msg: any) => ({
              id: msg.id,
              senderId: msg.senderId,
              recipientId: msg.recipientId,
              content: msg.content,
              timestamp: new Date(msg.timestamp),
              image: msg.image,
            }))
          );
        }
      } catch (error) {
        console.error('[ChatInterface] Error parsing SSE message:', error);
      }
    };

    eventSource.onerror = (error) => {
      console.error('[ChatInterface] SSE error:', error);
    };

    return () => {
      eventSource.close();
    };
  }, [userId, recipientId, thinkingWords]);

  // Render Settings page if on settings
  if (currentPage === 'settings') {
    return (
      <Settings
        onBack={() => setCurrentPage('chat')}
        isDarkMode={isDarkMode}
        onToggleDarkMode={() => setIsDarkMode(!isDarkMode)}
        userId={userId}
        onChatHistoryToggle={(enabled) => setChatHistoryEnabled(enabled)}
      />
    );
  }

  return (
    <div
      className={`h-screen flex overflow-hidden ${isDarkMode ? 'dark' : ''}`}
      style={{ backgroundColor: 'var(--background)' }}
    >
      {/* Main Chat Content */}
      <motion.div
        className="flex-1 flex flex-col relative"
        initial={{ x: 0 }}
        animate={{ x: 0 }}
        style={{ backgroundColor: 'var(--background)' }}
      >
        {/* Header */}
        <Header
          isDarkMode={isDarkMode}
          onToggleDarkMode={() => setIsDarkMode(!isDarkMode)}
          onSettingsClick={() => setCurrentPage('settings')}
          showMenuButton={chatHistoryEnabled}
        />

        {/* Main Content Area */}
        <div
          className="flex-1 overflow-y-auto relative"
          style={{
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
        >
          {/* Gradient background at bottom */}
          <div
            className="fixed bottom-0 left-0 right-0 pointer-events-none flex justify-center"
            style={{ height: '1000px', transform: 'translateY(660px)' }}
          >
            <MiraBackgroundAnimation />
          </div>

          {/* Welcome Screen */}
          <AnimatePresence mode="wait">
            {messages.length === 0 && !hasConnectedBefore && (
              <motion.div
                key="welcome-screen"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5 }}
                className="absolute inset-0 flex flex-col items-center justify-center px-6 z-10"
              >
                <div className="flex flex-col items-center -mt-[80px]">
                  <motion.div
                    initial={{ y: '5vh' }}
                    animate={{ y: 0 }}
                    transition={{
                      duration: 0.7,
                      ease: [0.25, 0.1, 0.25, 1],
                      delay: 0.3,
                    }}
                    className="mb-[10px]"
                  >
                    <Lottie
                      animationData={MentraLogoAnimation}
                      loop={true}
                      autoplay={true}
                      className="w-[150px] h-[150px]"
                    />
                  </motion.div>
                  <h1 className="text-[20px] sm:text-4xl md:text-5xl lg:text-6xl font-semibold flex gap-[4px] justify-center">
                    {['Say', '"Hey', 'Mentra"'].map((word, index) => (
                      <motion.span
                        key={index}
                        initial={{ opacity: 0, filter: 'blur(10px)' }}
                        animate={{ opacity: 1, filter: 'blur(0px)' }}
                        transition={{
                          duration: 0.5,
                          ease: [0.25, 0.1, 0.25, 1],
                          delay: 0.7 + index * 0.15,
                        }}
                        style={{ color: 'var(--secondary-foreground)' }}
                      >
                        {word}
                      </motion.span>
                    ))}
                  </h1>

                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.6,
                      ease: [0.25, 0.1, 0.25, 1],
                      delay: 1.15,
                    }}
                    className="text-[14px] text-[#A3A3A3] mt-[8px]"
                  >
                    Then ask a question.
                  </motion.div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Chat Messages */}
          {(messages.length > 0 || hasConnectedBefore) && (
            <motion.div
              initial={hasConnectedBefore ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: hasConnectedBefore ? 0 : 0.5, ease: 'easeOut' }}
              className="px-[24px] py-6 pb-[150px] relative z-20"
            >
              <div className="max-w-3xl mx-auto space-y-6">
                {messages.map((message, index) => (
                  <ChatBubble
                    key={message.id}
                    message={message}
                    isOwnMessage={message.senderId === userId}
                    index={index}
                  />
                ))}

                {/* Processing Indicator */}
                {isProcessing && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-2"
                  >
                    <div className="flex-shrink-0">
                      <img src={ColorMiraLogo} alt="Mentra" className="w-[40px] h-[40px]" />
                    </div>
                    <motion.div
                      className="text-sm text-gray-500 italic"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.3 }}
                    >
                      {`${thinkingWord}...`.split('').map((char, index) => (
                        <motion.span
                          key={index}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: index * 0.05 }}
                        >
                          {char}
                        </motion.span>
                      ))}
                    </motion.div>
                  </motion.div>
                )}

                <div ref={messagesEndRef} />
              </div>
            </motion.div>
          )}
        </div>

        {/* Bottom Header */}
        <BottomHeader isDarkMode={isDarkMode} isVisible={messages.length > 0} />
      </motion.div>

      {/* Image Zoom Modal */}
      {zoomedImage && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/95 z-50 flex items-center justify-center overflow-hidden"
        >
          <div className="relative w-full h-full flex items-center justify-center">
            <motion.img
              initial={{ scale: 0.9 }}
              animate={{
                scale: imageScale,
                x: imagePosition.x,
                y: imagePosition.y,
              }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              src={zoomedImage}
              alt="Zoomed view"
              className="max-w-full max-h-full object-contain rounded-lg select-none"
              style={{
                touchAction: 'none',
                cursor: isDragging ? 'grabbing' : 'grab',
              }}
              onWheel={(e) => {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                setImageScale((prev) => Math.min(Math.max(0.5, prev + delta), 5));
              }}
              onMouseDown={(e) => {
                setIsDragging(true);
                setDragStart({
                  x: e.clientX - imagePosition.x,
                  y: e.clientY - imagePosition.y,
                });
              }}
              onMouseMove={(e) => {
                if (isDragging) {
                  setImagePosition({
                    x: e.clientX - dragStart.x,
                    y: e.clientY - dragStart.y,
                  });
                }
              }}
              onMouseUp={() => setIsDragging(false)}
              onMouseLeave={() => setIsDragging(false)}
            />
            {/* Close button */}
            <button
              className="absolute top-4 left-4 w-[40px] h-[40px] bg-[var(--background)] backdrop-blur-sm rounded-full flex justify-center items-center z-10"
              onClick={() => {
                setZoomedImage(null);
                setImageScale(1);
                setImagePosition({ x: 0, y: 0 });
                setIsDragging(false);
              }}
            >
              <X size={20} color="var(--foreground)" />
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}

export default ChatInterface;
