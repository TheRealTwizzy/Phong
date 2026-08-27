import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { LanguageCode } from '../types';
import { Cosmetic } from '../game/cosmetics';
import { t } from '../i18n/translations';
import { sound } from '../audio/soundEffects';
import { MessageSquare, X, Send, Sparkles } from 'lucide-react';

export interface ChatMessage {
  id: string;
  text: string;
  senderName: string;
  isSelf: boolean;
  timestamp: number;
}

interface QuickChatProps {
  onSendMessage: (text: string) => void;
  activeMessages: ChatMessage[];
  theme: Cosmetic;
  language: LanguageCode;
  disabled?: boolean;
}

export const PRESET_CHAT_KEYS = [
  'chat_nice_shot',
  'chat_good_game',
  'chat_what_a_save',
  'chat_close_one',
  'chat_rematch',
  'chat_unlucky',
  'chat_lets_go',
  'chat_watch_this',
] as const;

export const QuickChat: React.FC<QuickChatProps> = ({
  onSendMessage,
  activeMessages,
  theme,
  language,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [cooldown, setCooldown] = useState(false);

  const handleSelect = (key: string) => {
    if (cooldown || disabled) return;
    const text = t(key, language);
    onSendMessage(text);
    setIsOpen(false);
    setCooldown(true);
    sound.playBallIncoming();

    // Prevent spamming
    setTimeout(() => {
      setCooldown(false);
    }, 1500);
  };

  return (
    <>
      {/* Floating Active Chat Speech Bubbles on Court */}
      <div className="absolute top-16 left-3 right-3 z-30 pointer-events-none flex flex-col gap-2 items-center">
        <AnimatePresence>
          {activeMessages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: -12, scale: 0.85 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.85 }}
              transition={{ type: 'spring', damping: 20, stiffness: 300 }}
              className={`px-3.5 py-1.5 rounded-full backdrop-blur-md shadow-xl flex items-center gap-2 border text-xs font-bold ${
                msg.isSelf
                  ? 'bg-accent/90 text-accent border-accent/50 shadow-surface-0/60'
                  : 'bg-surface-2/90 text-warn border-warn/50 shadow-surface-0/60'
              }`}
            >
              <span className="text-[10px] font-mono uppercase tracking-wider text-ink-muted">
                {msg.senderName}:
              </span>
              <span className="text-ink text-sm">{msg.text}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Quick Chat Tray Toggle Button */}
      <div className="absolute bottom-20 right-3 z-20">
        <button
          id="quick-chat-toggle-btn"
          onClick={() => setIsOpen(!isOpen)}
          disabled={disabled}
          title={t('quick_chat_title', language)}
          className={`p-2.5 rounded-full border shadow-lg backdrop-blur-md transition-all flex items-center justify-center ${
            isOpen
              ? 'bg-accent text-ink-on-accent border-accent scale-105'
              : 'bg-surface-2/80 text-accent border-accent/30 hover:bg-surface-3 hover:border-accent/60 active:scale-95'
          }`}
        >
          {isOpen ? <X className="w-5 h-5" /> : <MessageSquare className="w-5 h-5" />}
        </button>

        {/* Quick Chat Menu Grid */}
        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ opacity: 0, scale: 0.85, y: 10, x: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0, x: 0 }}
              exit={{ opacity: 0, scale: 0.85, y: 10, x: 10 }}
              transition={{ type: 'spring', damping: 22, stiffness: 350 }}
              className="absolute bottom-12 right-0 w-64 p-3 bg-surface-2/95 border border-line-strong/90 rounded-2xl shadow-2xl backdrop-blur-lg flex flex-col gap-1.5"
            >
              <div className="flex items-center justify-between pb-1.5 border-b border-line text-[11px] font-mono text-ink-muted font-bold px-1">
                <span>{t('quick_chat_title', language)}</span>
                <span className="text-accent text-[10px]">TAP TO SEND</span>
              </div>

              <div className="grid grid-cols-2 gap-1.5 max-h-48 scroll-y pt-1">
                {PRESET_CHAT_KEYS.map((key) => {
                  const label = t(key, language);
                  return (
                    <button
                      key={key}
                      onClick={() => handleSelect(key)}
                      disabled={cooldown}
                      className="px-2.5 py-2 text-left text-xs font-semibold bg-surface-3/80 hover:bg-accent/20 text-ink hover:text-accent border border-line-strong/60 hover:border-accent/40 rounded-xl transition-all active:scale-95 flex items-center justify-between leading-snug"
                    >
                      <span className="truncate">{label}</span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
};
