/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { MoreVertical, Battery, Wifi, Signal, Phone, Heart, Sparkles, Copy, CheckCircle2, XCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

const FloatingHeart = ({ delay = 0, x = 0 }: { delay?: number; x?: number; key?: number }) => (
  <motion.div
    initial={{ y: '100vh', opacity: 0, scale: 0.5 }}
    animate={{ 
      y: '-10vh', 
      opacity: [0, 1, 1, 0],
      scale: [0.5, 1, 1, 0.5],
      x: x + Math.sin(Date.now() / 1000) * 20
    }}
    transition={{ 
      duration: 10, 
      repeat: Infinity, 
      delay,
      ease: "linear"
    }}
    className="fixed pointer-events-none text-pink-300/30 z-0"
    style={{ left: `${x}%` }}
  >
    <Heart size={Math.random() * 20 + 10} fill="currentColor" />
  </motion.div>
);

export default function App() {
  const [time, setTime] = useState(new Date());
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isIslandExpanded, setIsIslandExpanded] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [language, setLanguage] = useState<'fr' | 'en' | null>(null);
  const [botStatus, setBotStatus] = useState<'online' | 'offline'>('offline');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Check for saved language
    const savedLang = localStorage.getItem('mini-xd-lang') as 'fr' | 'en' | null;
    if (savedLang) {
      setLanguage(savedLang);
    }
    
    // Fetch current language from server
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        if (data.language && !savedLang) {
          setLanguage(data.language);
          localStorage.setItem('mini-xd-lang', data.language);
        }
      })
      .catch(err => console.error('Error fetching settings:', err));

    // Fetch bot status
    const fetchStatus = () => {
      fetch('/api/status')
        .then(res => res.json())
        .then(data => setBotStatus(data.status))
        .catch(() => setBotStatus('offline'));
    };
    
    fetchStatus();
    const statusInterval = setInterval(fetchStatus, 30000);

    // Update time every second
    const timer = setInterval(() => setTime(new Date()), 1000);

    // Get battery level
    if ('getBattery' in navigator) {
      (navigator as any).getBattery().then((battery: any) => {
        setBatteryLevel(Math.round(battery.level * 100));
        battery.addEventListener('levelchange', () => {
          setBatteryLevel(Math.round(battery.level * 100));
        });
      });
    }

    return () => clearInterval(timer);
  }, []);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  };

  const handleLanguageSelect = async (lang: 'fr' | 'en') => {
    setLanguage(lang);
    localStorage.setItem('mini-xd-lang', lang);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang })
      });
    } catch (error) {
      console.error('Error saving language to server:', error);
    }
  };

  const handleGetPairingCode = async () => {
    if (!phoneNumber) {
      alert(language === 'fr' ? 'Veuillez entrer votre numéro WhatsApp' : 'Please enter your WhatsApp number');
      return;
    }
    
    setIsLoading(true);
    setPairingCode(null);
    setIsIslandExpanded(true);

    try {
      const response = await fetch(`/api/pairing-code?phone=${encodeURIComponent(phoneNumber)}`);
      const data = await response.json();
      
      if (data.code) {
        setPairingCode(data.code);
      } else if (data.message) {
        alert(data.message);
      } else if (data.error) {
        alert(data.error);
      } else {
        alert(language === 'fr' ? 'Erreur lors de la génération du code' : 'Error generating pairing code');
      }
    } catch (error) {
      console.error(error);
      alert(language === 'fr' ? 'Erreur de connexion au serveur' : 'Server connection error');
    } finally {
      setIsLoading(false);
      setTimeout(() => setIsIslandExpanded(false), 3000);
    }
  };

  const copyToClipboard = () => {
    if (pairingCode) {
      navigator.clipboard.writeText(pairingCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-pink-50 text-pink-900 font-sans selection:bg-pink-200 overflow-hidden flex flex-col relative">
      {/* Floating Hearts Background */}
      {[...Array(15)].map((_, i) => (
        <FloatingHeart key={i} delay={i * 2} x={Math.random() * 100} />
      ))}

      {/* Language Selection Modal */}
      <AnimatePresence>
        {!language && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-pink-900/40 backdrop-blur-xl flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white w-full max-w-xs rounded-[2.5rem] p-8 shadow-2xl space-y-8 text-center"
            >
              <div className="space-y-2">
                <h3 className="text-2xl font-black text-pink-600">CHOOSE LANGUAGE</h3>
                <p className="text-pink-400 text-sm font-medium">Sélectionnez votre langue</p>
              </div>
              
              <div className="grid gap-4">
                <button 
                  onClick={() => handleLanguageSelect('fr')}
                  className="w-full bg-pink-50 hover:bg-pink-100 text-pink-600 font-bold py-4 rounded-2xl transition-colors flex items-center justify-center gap-3"
                >
                  <span className="text-2xl">🇫🇷</span> Français
                </button>
                <button 
                  onClick={() => handleLanguageSelect('en')}
                  className="w-full bg-pink-50 hover:bg-pink-100 text-pink-600 font-bold py-4 rounded-2xl transition-colors flex items-center justify-center gap-3"
                >
                  <span className="text-2xl">🇬🇧</span> English
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* iOS Status Bar */}
      <div className="h-12 px-6 flex items-center justify-between z-50 fixed top-0 w-full bg-pink-50/80 backdrop-blur-md">
        <div className="text-sm font-semibold">
          {formatTime(time)}
        </div>
        
        {/* Dynamic Island */}
        <motion.div 
          layout
          initial={{ width: 100, height: 28 }}
          animate={{ 
            width: isIslandExpanded ? 240 : 100, 
            height: isIslandExpanded ? 60 : 28,
            borderRadius: 30
          }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="bg-black flex items-center justify-center overflow-hidden cursor-pointer"
          onClick={() => setIsIslandExpanded(!isIslandExpanded)}
        >
          <AnimatePresence mode="wait">
            {!isIslandExpanded ? (
              <motion.div 
                key="island-collapsed"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2"
              >
                <div className="w-2 h-2 rounded-full bg-pink-400 animate-pulse" />
                <span className="text-[10px] text-white font-medium uppercase tracking-widest">MINI-XD</span>
              </motion.div>
            ) : (
              <motion.div 
                key="island-expanded"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className="flex items-center gap-4 px-4 w-full"
              >
                <img 
                  src="https://lieixmgdboiceopzksvu.supabase.co/storage/v1/object/public/hosted-files/9nwmikgq-1773928282038.jpg" 
                  alt="Bot" 
                  className="w-10 h-10 rounded-full border border-pink-500/30"
                  referrerPolicy="no-referrer"
                />
                <div className="flex flex-col">
                  <span className="text-xs text-white font-bold">MINI-XD V2</span>
                  <span className="text-[10px] text-pink-300">
                    {isLoading 
                      ? (language === 'fr' ? 'Génération...' : 'Generating...') 
                      : (language === 'fr' ? 'Code Prêt !' : 'Code Ready!')}
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        <div className="flex items-center gap-1.5">
          <Signal size={14} strokeWidth={2.5} />
          <Wifi size={14} strokeWidth={2.5} />
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-bold">{batteryLevel ?? '--'}%</span>
            <Battery size={16} strokeWidth={2.5} className="rotate-0" />
          </div>
        </div>
      </div>

      {/* Header with Bot Photo & Menu */}
      <header className="pt-16 px-6 flex justify-between items-start">
        <div className="flex flex-col">
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-center gap-2 mb-1"
          >
            <div className={`w-2 h-2 rounded-full ${botStatus === 'online' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-400'}`} />
            <span className="text-[10px] font-bold uppercase tracking-widest text-pink-400">
              {botStatus === 'online' ? 'Bot Online' : 'Bot Offline'}
            </span>
          </motion.div>
          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-4xl font-black tracking-tighter text-pink-600"
          >
            MINI-XD <span className="text-pink-400">V2</span>
          </motion.h1>
          <p className="text-pink-400 text-sm font-medium mt-1 italic flex items-center gap-1">
            <Sparkles size={12} />
            {language === 'fr' ? 'Bot WhatsApp Esthétique' : 'Aesthetic WhatsApp Bot'}
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          <button className="p-2 hover:bg-pink-100 rounded-full transition-colors">
            <MoreVertical size={24} className="text-pink-500" />
          </button>
          <motion.div 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="relative"
          >
            <div className="absolute -inset-1 bg-gradient-to-tr from-pink-400 to-rose-300 rounded-full blur opacity-40 animate-pulse" />
            <img 
              src="https://lieixmgdboiceopzksvu.supabase.co/storage/v1/object/public/hosted-files/9nwmikgq-1773928282038.jpg" 
              alt="Bot Profile" 
              className="w-14 h-14 rounded-full border-2 border-white shadow-lg relative z-10 object-cover"
              referrerPolicy="no-referrer"
            />
          </motion.div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center px-8 gap-12">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2 }}
          className="w-full max-w-sm space-y-8"
        >
          <div className="text-center space-y-2">
            <h2 className="text-2xl font-bold text-pink-700">
              {language === 'fr' ? 'Connexion Rapide' : 'Quick Connect'}
            </h2>
            <p className="text-pink-400 text-sm">
              {language === 'fr' ? 'Entrez votre numéro pour lier le bot' : 'Enter your number to link the bot'}
            </p>
          </div>

          <div className="space-y-4">
            <div className="relative group">
              <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                <Phone size={18} className="text-pink-300 group-focus-within:text-pink-500 transition-colors" />
              </div>
              <input 
                type="tel" 
                placeholder="Ex: +225 0102030405"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                className="w-full bg-white border-2 border-pink-100 rounded-2xl py-4 pl-12 pr-4 text-lg focus:outline-none focus:border-pink-400 focus:ring-4 focus:ring-pink-100 transition-all placeholder:text-pink-200 shadow-sm"
              />
            </div>
          </div>

          {/* Bot Stats Section */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white/60 backdrop-blur-sm p-4 rounded-3xl border border-pink-100 flex flex-col items-center gap-1">
              <span className="text-[10px] font-bold text-pink-400 uppercase tracking-widest">Uptime</span>
              <span className="text-sm font-black text-pink-600">Active</span>
            </div>
            <div className="bg-white/60 backdrop-blur-sm p-4 rounded-3xl border border-pink-100 flex flex-col items-center gap-1">
              <span className="text-[10px] font-bold text-pink-400 uppercase tracking-widest">Version</span>
              <span className="text-sm font-black text-pink-600">2.0.0</span>
            </div>
          </div>
        </motion.div>
      </main>

      {/* Bottom Action */}
      <footer className="p-8 pb-12 space-y-4">
        <AnimatePresence>
          {pairingCode && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="bg-white border-2 border-pink-200 rounded-3xl p-6 flex flex-col items-center gap-3 shadow-xl relative overflow-hidden group"
            >
              <div className="absolute top-0 right-0 p-2 opacity-20 group-hover:opacity-100 transition-opacity">
                <Sparkles size={24} className="text-pink-400" />
              </div>
              
              <span className="text-xs font-bold text-pink-400 uppercase tracking-widest">
                {language === 'fr' ? 'Votre Code de Jumelage' : 'Your Pairing Code'}
              </span>
              
              <div 
                onClick={copyToClipboard}
                className="flex items-center gap-4 cursor-pointer hover:scale-105 transition-transform"
              >
                <div className="text-4xl font-mono font-black text-pink-600 tracking-[0.2em]">
                  {pairingCode}
                </div>
                <div className={`p-2 rounded-full ${copied ? 'bg-green-100 text-green-600' : 'bg-pink-100 text-pink-600'} transition-colors`}>
                  {copied ? <CheckCircle2 size={20} /> : <Copy size={20} />}
                </div>
              </div>
              
              <span className="text-[10px] text-pink-300 font-medium">
                {copied 
                  ? (language === 'fr' ? 'Copié dans le presse-papier !' : 'Copied to clipboard!') 
                  : (language === 'fr' ? 'Cliquez pour copier et lier votre WhatsApp' : 'Click to copy and link your WhatsApp')}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={handleGetPairingCode}
          disabled={isLoading}
          className={`w-full bg-gradient-to-r from-pink-500 to-rose-400 text-white font-bold py-5 rounded-2xl shadow-xl shadow-pink-200 flex items-center justify-center gap-2 text-lg uppercase tracking-wider ${isLoading ? 'opacity-70 cursor-not-allowed' : ''}`}
        >
          {isLoading 
            ? (language === 'fr' ? 'Génération...' : 'Generating...') 
            : (language === 'fr' ? 'Obtenir le code' : 'Get pairing code')}
        </motion.button>
        
        {/* iOS Home Indicator */}
        <div className="mt-8 flex justify-center">
          <div className="w-32 h-1.5 bg-pink-200 rounded-full" />
        </div>
      </footer>

      {/* Aesthetic Background Elements */}
      <div className="fixed -bottom-20 -left-20 w-64 h-64 bg-pink-200/20 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed -top-20 -right-20 w-80 h-80 bg-rose-200/20 rounded-full blur-3xl pointer-events-none" />
    </div>
  );
}
