import { useState, useEffect } from 'react';
import { 
  Shield, 
  Zap, 
  Terminal, 
  Phone, 
  Copy, 
  CheckCircle2, 
  XCircle, 
  Lock,
  ChevronRight,
  Key,
  Info,
  Activity
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

const TechBackground = () => (
  <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
    <div className="absolute inset-0 bg-tech-grid opacity-50 animate-grid-scroll" />
    <div className="absolute inset-0 bg-gradient-to-b from-deep-black via-transparent to-deep-black" />
    <div className="absolute top-0 left-0 w-full h-1 bg-neon-red/20 animate-scanline" />
  </div>
);

export default function App() {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [language, setLanguage] = useState<'fr' | 'en' | null>(null);
  const [botStatus, setBotStatus] = useState<'online' | 'offline'>('offline');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const savedLang = localStorage.getItem('mini-xd-lang') as 'fr' | 'en' | null;
    if (savedLang) {
      setLanguage(savedLang);
    }
    
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        if (data.language && !savedLang) {
          setLanguage(data.language);
          localStorage.setItem('mini-xd-lang', data.language);
        }
      })
      .catch(err => console.error('Error fetching settings:', err));

    const fetchStatus = () => {
      fetch('/api/status')
        .then(res => res.json())
        .then(data => setBotStatus(data.status))
        .catch(() => setBotStatus('offline'));
    };
    
    fetchStatus();
    const statusInterval = setInterval(fetchStatus, 30000);

    return () => clearInterval(statusInterval);
  }, []);

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
    if (!phoneNumber) return;
    
    setIsLoading(true);
    setPairingCode(null);

    try {
      const response = await fetch(`/api/pairing-code?phone=${encodeURIComponent(phoneNumber)}`);
      const data = await response.json();
      
      if (data.code) {
        setPairingCode(data.code);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = () => {
    if (pairingCode) {
      navigator.clipboard.writeText(pairingCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const t = (fr: string, en: string) => (language === 'fr' ? fr : en);

  return (
    <div className="min-h-screen bg-deep-black text-white font-ops selection:bg-neon-red/30 overflow-x-hidden flex flex-col relative">
      <TechBackground />

      {/* Language Selection Overlay */}
      <AnimatePresence>
        {!language && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-deep-black flex items-center justify-center p-6"
          >
            <div className="absolute inset-0 bg-tech-grid opacity-20" />
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="military-card border-flow-effect w-full max-w-md p-10 rounded-sm glow-red relative z-10 text-center space-y-8"
            >
              <div className="flex justify-center">
                <div className="w-16 h-16 rounded-full border-2 border-neon-red flex items-center justify-center text-neon-red">
                  <Terminal size={32} />
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="text-2xl font-black tracking-widest text-ops">INITIALIZING...</h3>
                <p className="text-white/40 text-[10px] uppercase tracking-[0.2em]">Select Operational Language</p>
              </div>
              
              <div className="grid grid-cols-1 gap-4">
                <button 
                  onClick={() => handleLanguageSelect('fr')}
                  className="group relative bg-white/5 hover:bg-neon-red/10 border border-white/10 hover:border-neon-red/50 p-5 rounded-sm transition-all flex items-center justify-between"
                >
                  <span className="font-bold tracking-widest text-sm">FRANÇAIS</span>
                  <ChevronRight size={18} className="text-neon-red group-hover:translate-x-1 transition-transform" />
                </button>
                
                <button 
                  onClick={() => handleLanguageSelect('en')}
                  className="group relative bg-white/5 hover:bg-neon-red/10 border border-white/10 hover:border-neon-red/50 p-5 rounded-sm transition-all flex items-center justify-between"
                >
                  <span className="font-bold tracking-widest text-sm">ENGLISH</span>
                  <ChevronRight size={18} className="text-neon-red group-hover:translate-x-1 transition-transform" />
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main UI */}
      <div className="relative z-10 flex flex-col min-h-screen">
        {/* Header */}
        <header className="p-6 md:px-12 flex justify-between items-center w-full border-b border-white/5 bg-deep-black/80 backdrop-blur-md">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-sm border border-neon-red/30 p-1 overflow-hidden">
              <img 
                src="https://lieixmgdboiceopzksvu.supabase.co/storage/v1/object/public/hosted-files/9nwmikgq-1773928282038.jpg" 
                alt="Logo" 
                className="w-full h-full rounded-sm object-cover grayscale brightness-125"
                referrerPolicy="no-referrer"
              />
            </div>
            <div className="flex flex-col">
              <h1 className="text-lg md:text-xl font-black tracking-[0.2em] text-white">
                MINI-XD <span className="text-neon-red">•</span> {t('OPÉRATIONNEL', 'OPERATIONAL')}
              </h1>
              <span className="text-[9px] font-bold text-white/30 tracking-widest">Created by Samy Charles</span>
            </div>
          </div>
          
          <div className="flex flex-col items-end">
            <span className="text-[10px] font-black text-neon-red tracking-widest">v2.0</span>
            <div className="flex items-center gap-1.5 mt-1">
              <div className={`w-1.5 h-1.5 rounded-full ${botStatus === 'online' ? 'bg-neon-red animate-pulse' : 'bg-white/20'}`} />
              <span className="text-[8px] font-bold uppercase tracking-tighter text-white/40">
                {botStatus === 'online' ? 'System Active' : 'System Idle'}
              </span>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1 flex flex-col items-center py-12 px-6 max-w-4xl mx-auto w-full gap-8">
          {/* Main Card */}
          <motion.section 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="military-card border-flow-effect w-full p-8 md:p-10 rounded-sm glow-red space-y-8"
          >
            <div className="flex items-center gap-3 border-b border-white/5 pb-4">
              <Activity size={20} className="text-neon-red" />
              <h2 className="text-sm md:text-base font-black tracking-[0.2em]">
                {t('GÉNÉRER LE CODE D’APPAIRAGE', 'GENERATE PAIRING CODE')}
              </h2>
            </div>

            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest ml-1">
                  {t('Numéro WhatsApp (avec indicatif)', 'WhatsApp Number (with country code)')}
                </label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-5 flex items-center pointer-events-none">
                    <Key size={18} className="text-white/20 group-focus-within:text-neon-red transition-colors" />
                  </div>
                  <input 
                    type="tel" 
                    placeholder="Ex: +225 0102030405"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-sm py-5 pl-14 pr-6 text-lg font-mono focus:outline-none focus:border-neon-red/50 focus:ring-1 focus:ring-neon-red/20 transition-all placeholder:text-white/10"
                  />
                </div>
              </div>

              <AnimatePresence>
                {pairingCode && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="bg-neon-red/5 border border-neon-red/30 rounded-sm p-6 flex flex-col items-center gap-3 relative"
                  >
                    <div className="absolute top-3 right-3 text-neon-red/20">
                      <Lock size={14} />
                    </div>
                    
                    <span className="text-[9px] font-black text-neon-red uppercase tracking-[0.3em]">
                      {t('CODE GÉNÉRÉ', 'CODE GENERATED')}
                    </span>
                    
                    <div 
                      onClick={copyToClipboard}
                      className="flex items-center gap-4 cursor-pointer group"
                    >
                      <div className="text-3xl md:text-4xl font-black text-white tracking-[0.2em] font-mono">
                        {pairingCode}
                      </div>
                      <div className={`p-2 rounded-sm border ${copied ? 'bg-neon-red text-white border-neon-red' : 'border-neon-red/30 text-neon-red'} transition-all`}>
                        {copied ? <CheckCircle2 size={18} /> : <Copy size={18} />}
                      </div>
                    </div>
                    
                    <p className="text-[8px] text-white/40 font-bold uppercase tracking-widest text-center">
                      {copied 
                        ? t('COPIÉ DANS LE PRESSE-PAPIER', 'COPIED TO CLIPBOARD') 
                        : t('CLIQUEZ POUR COPIER LE CODE', 'CLICK TO COPY THE CODE')}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>

              <button
                onClick={handleGetPairingCode}
                disabled={isLoading || !phoneNumber}
                className={`w-full bg-neon-red text-white font-black py-5 rounded-sm text-sm uppercase tracking-[0.3em] transition-all active:scale-95 flex items-center justify-center gap-3 shadow-[0_0_20px_rgba(255,26,26,0.2)] hover:shadow-[0_0_30px_rgba(255,26,26,0.4)] hover:bg-neon-red/90 ${isLoading || !phoneNumber ? 'opacity-50 cursor-not-allowed grayscale' : ''}`}
              >
                {isLoading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    {t('GÉNÉRATION...', 'GENERATING...')}
                  </>
                ) : (
                  <>
                    <Zap size={18} />
                    {t('GÉNÉRER LE CODE', 'GENERATE CODE')}
                  </>
                )}
              </button>
            </div>
          </motion.section>

          {/* Instructions Card */}
          <motion.section 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="military-card w-full p-8 md:p-10 rounded-sm border border-white/5 space-y-8"
          >
            <div className="flex items-center gap-3 border-b border-white/5 pb-4">
              <Info size={20} className="text-neon-red" />
              <h2 className="text-sm md:text-base font-black tracking-[0.2em]">
                {t('COMMENT CONNECTER LE BOT', 'HOW TO CONNECT THE BOT')}
              </h2>
            </div>

            <div className="space-y-6">
              {[
                t('Entrez votre numéro avec indicatif pays', 'Enter your number with country code'),
                t('Cliquez sur Générer le code', 'Click on Generate code'),
                t('Ouvrez WhatsApp → Appareils liés → Lier un appareil', 'Open WhatsApp → Linked Devices → Link a device'),
                t('Saisissez le code affiché', 'Enter the displayed code')
              ].map((step, i) => (
                <div key={i} className="flex items-start gap-5 group">
                  <div className="flex-shrink-0 w-8 h-8 rounded-sm bg-neon-red/10 border border-neon-red/30 flex items-center justify-center text-neon-red font-black text-xs group-hover:bg-neon-red group-hover:text-white transition-all">
                    {i + 1}
                  </div>
                  <p className="text-xs md:text-sm text-white/60 leading-relaxed pt-1.5">
                    {step}
                  </p>
                </div>
              ))}
            </div>
          </motion.section>
        </main>

        {/* Footer */}
        <footer className="p-8 text-center border-t border-white/5 bg-deep-black/80">
          <div className="flex justify-center gap-8 text-[9px] font-black uppercase tracking-[0.3em] text-white/20">
            <span>CORE_V2.0</span>
            <span>•</span>
            <span>MINI-XD_OPS</span>
            <span>•</span>
            <span>SECURE_LINK</span>
          </div>
          <p className="text-[8px] text-white/10 uppercase tracking-widest mt-4">
            © 2026 MINI-XD TECH. ALL RIGHTS RESERVED.
          </p>
        </footer>
      </div>
    </div>
  );
}
