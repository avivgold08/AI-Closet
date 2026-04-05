import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Shirt, 
  User, 
  Sparkles, 
  Plus, 
  Trash2, 
  Camera, 
  LayoutGrid, 
  Wand2, 
  Sun, 
  CloudRain, 
  School, 
  PartyPopper,
  Loader2,
  Check,
  X,
  LogIn,
  LogOut,
  Pencil,
  UserCircle
} from 'lucide-react';
import { Toaster, toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut, 
  User as FirebaseUser 
} from 'firebase/auth';
import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  deleteDoc, 
  onSnapshot, 
  query, 
  orderBy,
  getDocFromServer,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import { cn } from './lib/utils';
import { ClothingItem, ClothingCategory, UserProfile, OutfitRecommendation } from './types';
import { getOutfitRecommendation, virtualTryOn, tagClothingItem } from './services/geminiService';
import { auth, db } from './firebase';

// --- Error Handling ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  
  // Only show toasts for write/delete operations that fail.
  // Be silent for GET/LIST operations to reduce noise.
  if (operationType === OperationType.WRITE || operationType === OperationType.DELETE || operationType === OperationType.UPDATE) {
    toast.error('נתקלנו בבעיה בשמירת הנתונים. אנא נסי שוב בעוד רגע.');
  }
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
          <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">אופס, משהו השתבש</h2>
            <p className="text-gray-600 mb-6">נתקלנו בשגיאה בלתי צפויה. אנא נסה לרענן את הדף.</p>
            <button 
              onClick={() => window.location.reload()}
              className="w-full bg-black text-white py-3 rounded-xl font-medium hover:bg-gray-800 transition-colors"
            >
              רענן דף
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const CATEGORIES: { id: ClothingCategory; label: string }[] = [
  { id: 'top', label: 'חלק עליון' },
  { id: 'hoodie', label: 'קפוצ׳ונים' },
  { id: 'bottom', label: 'חלק תחתון (מכנסיים/חצאית)' },
  { id: 'full-body', label: 'גוף מלא' },
  { id: 'shoes', label: 'נעליים' },
  { id: 'accessory', label: 'אביזרים' },
];

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState<'closet' | 'tryon' | 'recommend'>('closet');
  const [clothes, setClothes] = useState<ClothingItem[]>([]);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isTagging, setIsTagging] = useState(false);
  
  const [selectedItems, setSelectedItems] = useState<Record<ClothingCategory, ClothingItem | null>>({
    top: null,
    bottom: null,
    'full-body': null,
    shoes: null,
    accessory: null,
    hoodie: null,
  });
  const [tryOnResult, setTryOnResult] = useState<string | null>(null);
  const [recommendation, setRecommendation] = useState<OutfitRecommendation | null>(null);
  const [selectedOccasion, setSelectedOccasion] = useState<string | null>(null);
  const [customOccasion, setCustomOccasion] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [filterCategory, setFilterCategory] = useState<ClothingCategory | 'all'>('all');
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [pendingCategory, setPendingCategory] = useState<ClothingCategory>('top');
  const [pendingName, setPendingName] = useState('');

  const ensureUserProfile = async (u: FirebaseUser) => {
    try {
      const profileRef = doc(db, 'users', u.uid);
      const profileSnap = await getDoc(profileRef);
      if (!profileSnap.exists()) {
        await setDoc(profileRef, {
          uid: u.uid,
          displayName: u.displayName || '',
          email: u.email || '',
          photoUrl: '', // Initial empty photo
          role: 'user'
        });
      }
    } catch (error) {
      console.error("Profile creation error:", error);
      // Don't show toast here as it might be a transient issue or handled by onSnapshot
    }
  };

  // --- Auth & Initial Connection Test ---
  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        ensureUserProfile(u);
      }
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // --- Data Sync ---
  useEffect(() => {
    if (!user || !isAuthReady) {
      setClothes([]);
      setUserProfile(null);
      return;
    }

    // Sync Profile
    const profileRef = doc(db, 'users', user.uid);
    const unsubProfile = onSnapshot(profileRef, (snap) => {
      if (snap.exists()) {
        setUserProfile(snap.data() as UserProfile);
      }
    }, (err) => handleFirestoreError(err, OperationType.GET, `users/${user.uid}`));

    // Sync Clothes
    const clothesRef = collection(db, 'users', user.uid, 'clothes');
    const q = query(clothesRef, orderBy('createdAt', 'desc'));
    const unsubClothes = onSnapshot(q, (snap) => {
      const items = snap.docs.map(d => d.data() as ClothingItem);
      setClothes(items);
    }, (err) => handleFirestoreError(err, OperationType.LIST, `users/${user.uid}/clothes`));

    return () => {
      unsubProfile();
      unsubClothes();
    };
  }, [user, isAuthReady]);

  // Clear try-on result when user photo changes
  useEffect(() => {
    setTryOnResult(null);
  }, [userProfile?.photoUrl]);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      const result = await signInWithPopup(auth, provider);
      const u = result.user;
      await ensureUserProfile(u);
      toast.success('התחברת בהצלחה!');
    } catch (error: any) {
      console.error("Login error:", error);
      toast.error('נכשלנו בהתחברות. אנא נסי שוב.');
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      toast.success('התנתקת בהצלחה.');
    } catch (error) {
      console.error("Logout error:", error);
      toast.error('נכשלנו בהתנתקות.');
    }
  };

  const resizeImage = (base64Str: string, maxWidth = 1200, maxHeight = 1200): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxWidth) {
            height *= maxWidth / width;
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width *= maxHeight / height;
            height = maxHeight;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = (err) => {
        console.error("Image load error:", err);
        reject(new Error("נכשלנו בטעינת התמונה לעיבוד."));
      };
      img.src = base64Str;
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, type: 'clothing' | 'profile') => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onerror = () => {
      toast.error('שגיאה בקריאת הקובץ.');
    };
    reader.onloadend = async () => {
      try {
        const originalBase64 = reader.result as string;
        const base64 = await resizeImage(originalBase64);
        
        if (type === 'clothing') {
          setPendingImage(base64);
          setPendingName(file.name.split('.')[0]);
          setIsUploadModalOpen(true);
        } else {
          if (!user) return;
          try {
            const profileRef = doc(db, 'users', user.uid);
            await setDoc(profileRef, { 
              uid: user.uid, 
              photoUrl: base64,
              email: user.email || '',
              displayName: user.displayName || ''
            }, { merge: true });
            toast.success('תמונת הפרופיל עודכנה!');
          } catch (err) {
            handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
          }
        }
      } catch (err) {
        console.error("File processing error:", err);
        toast.error('נכשלנו בעיבוד הקובץ. אנא נסי קובץ אחר.');
      }
    };
    reader.readAsDataURL(file);
  };

  const saveClothingItem = async () => {
    if (!pendingImage || !user) return;
    
    setIsTagging(true);
    try {
      const tags = await tagClothingItem(pendingImage, pendingName, pendingCategory);
      
      const clothesRef = collection(db, 'users', user.uid, 'clothes');
      const itemDoc = doc(clothesRef);
      const itemId = itemDoc.id;
      
      const newItem: ClothingItem = {
        id: itemId,
        uid: user.uid,
        name: pendingName || 'פריט חדש',
        category: pendingCategory,
        imageUrl: pendingImage,
        tags: tags || [],
        createdAt: serverTimestamp(),
      };
      
      await setDoc(itemDoc, newItem);
      setIsUploadModalOpen(false);
      setPendingImage(null);
      toast.success('הפריט נוסף לארון!');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/clothes`);
    } finally {
      setIsTagging(false);
    }
  };

  const deleteClothingItem = async (item: ClothingItem) => {
    if (!user) return;
    const itemToDelete = item;
    try {
      const itemRef = doc(db, 'users', user.uid, 'clothes', item.id);
      await deleteDoc(itemRef);
      toast.success(`הפריט "${item.name}" נמחק`, {
        action: {
          label: 'ביטול',
          onClick: async () => {
            try {
              await setDoc(itemRef, itemToDelete);
            } catch (err) {
              handleFirestoreError(err, OperationType.WRITE, itemRef.path);
            }
          }
        }
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/clothes/${item.id}`);
    }
  };

  const updateClothingItemName = async (itemId: string, newName: string) => {
    if (!user || !newName.trim()) {
      setEditingItemId(null);
      return;
    }
    try {
      const itemRef = doc(db, 'users', user.uid, 'clothes', itemId);
      await updateDoc(itemRef, { name: newName.trim() });
      setEditingItemId(null);
      toast.success('השם עודכן בהצלחה');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/clothes/${itemId}`);
    }
  };

  const handleTryOn = async (items?: ClothingItem[], shouldSwitchTab: boolean = true) => {
    if (!userProfile?.photoUrl) {
      toast('אנא העלי תמונה שלך קודם בלשונית "מדידה"', { icon: '📸' });
      setActiveTab('tryon');
      return;
    }

    let itemsToTry: ClothingItem[] = [];
    let nextSelection = { ...selectedItems };
    
    if (items && items.length > 0) {
      // If items are provided (e.g. from recommendation), we usually want to replace the current selection
      // However, we only replace the categories that are present in the recommendation
      // OR we can clear everything first if it's a "complete" recommendation.
      // Let's clear categories that are mutually exclusive.
      
      items.forEach(item => {
        if (item.category === 'full-body') {
          nextSelection.top = null;
          nextSelection.bottom = null;
          nextSelection.hoodie = null;
        }
        if (item.category === 'top' || item.category === 'bottom' || item.category === 'hoodie') {
          nextSelection['full-body'] = null;
        }
        if (item.category === 'top') {
          nextSelection.hoodie = null;
        }
        if (item.category === 'hoodie') {
          nextSelection.top = null;
        }
        nextSelection[item.category] = item;
      });

      setSelectedItems(nextSelection);

      itemsToTry = Object.values(nextSelection)
        .filter((i): i is ClothingItem => i !== null);
    } else {
      itemsToTry = Object.values(selectedItems)
        .filter((i): i is ClothingItem => i !== null);
    }

    if (itemsToTry.length === 0) {
      toast.error('אנא בחרי לפחות פריט אחד למדידה');
      return;
    }

    // Check for API Key selection for Gemini 3.1
    const aistudio = (window as any).aistudio;
    if (aistudio) {
      const hasKey = await aistudio.hasSelectedApiKey();
      if (!hasKey) {
        toast.info('לצורך המדידה הווירטואלית, עליך לבחור מפתח API של Gemini.');
        await aistudio.openSelectKey();
        // Proceeding anyway as per guidelines to avoid race conditions
      }
    }
    
    setIsProcessing(true);
    setTryOnResult(null);
    try {
      const result = await virtualTryOn(userProfile?.photoUrl || '', itemsToTry);
      setTryOnResult(result);
      if (shouldSwitchTab) {
        setActiveTab('tryon');
      }
      toast.success('המדידה הושלמה!');
    } catch (error: any) {
      console.error("Virtual Try-On Error:", error);
      let errorMessage = 'נכשלנו ביצירת תמונת המדידה.';
      
      if (error.message?.includes("SAFETY") || error.message?.includes("בטיחות")) {
        errorMessage = 'התמונה נחסמה מטעמי בטיחות. נסי להשתמש בתמונה ברורה וצנועה יותר.';
      } else if (error.message?.includes("Requested entity was not found") || error.message?.includes("404") || error.message?.includes("PERMISSION_DENIED") || error.message?.includes("403")) {
        errorMessage = 'אין גישה למודל המתקדם או שהמפתח אינו תקין. אנא וודאי שבחרת מפתח API תקין (ייתכן שנדרש מפתח בתשלום למודלים אלו).';
        await (window as any).aistudio?.openSelectKey();
      } else if (error.message?.includes("API key not valid") || error.message?.includes("401")) {
        errorMessage = 'מפתח ה-API אינו תקין. אנא בחרי מפתח חדש.';
        await (window as any).aistudio?.openSelectKey();
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      toast.error(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  };

  const toggleSelectedItem = (item: ClothingItem) => {
    setSelectedItems(prev => {
      const isSelecting = prev[item.category]?.id !== item.id;
      const next = { ...prev };

      if (isSelecting) {
        // If selecting full-body, remove top, bottom and hoodie
        if (item.category === 'full-body') {
          next.top = null;
          next.bottom = null;
          next.hoodie = null;
        }
        // If selecting top, bottom or hoodie, remove full-body
        if (item.category === 'top' || item.category === 'bottom' || item.category === 'hoodie') {
          next['full-body'] = null;
        }
        // If selecting top, remove hoodie. If selecting hoodie, remove top.
        if (item.category === 'top') {
          next.hoodie = null;
        }
        if (item.category === 'hoodie') {
          next.top = null;
        }
        next[item.category] = item;
      } else {
        next[item.category] = null;
      }

      return next;
    });
  };

  const handleGetRecommendation = async (occasion: string) => {
    setSelectedOccasion(occasion);
    setIsProcessing(true);
    setRecommendation(null);
    setTryOnResult(null);
    try {
      const result = await getOutfitRecommendation(clothes, occasion);
      setRecommendation(result);
      toast.success('ההמלצה מוכנה! מכין את המדידה...');
      
      // Automatically trigger try-on if user has a photo
      if (userProfile?.photoUrl && result.items.length > 0) {
        await handleTryOn(result.items, false);
      }
    } catch (error) {
      console.error(error);
      if (error instanceof Error && error.message === "הארון ריק") {
        toast.error("הארון שלך עדיין ריק! הוסיפי בגדים קודם.");
      } else {
        toast.error('נכשלנו בקבלת המלצה.');
      }
    } finally {
      setIsProcessing(false);
    }
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F5F5]">
        <Loader2 className="w-12 h-12 animate-spin text-black" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#F5F5F5] flex flex-col items-center justify-center p-4 text-center space-y-8" dir="rtl">
        <div className="w-24 h-24 bg-black rounded-3xl flex items-center justify-center shadow-2xl">
          <Sparkles className="text-white w-12 h-12" />
        </div>
        <div className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">ארון וירטואלי</h1>
          <p className="text-gray-500 text-lg max-w-md">התחברי כדי לנהל את הארון שלך, למדוד בגדים וירטואלית ולקבל המלצות סטיילינג אישיות.</p>
        </div>
        <button 
          onClick={handleLogin}
          className="bg-black text-white px-12 py-4 rounded-2xl font-bold text-lg flex items-center gap-3 hover:bg-gray-800 transition-all shadow-lg"
        >
          <LogIn className="w-6 h-6" />
          התחברות עם Google
        </button>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-[#F5F5F5] text-[#1A1A1A] font-sans" dir="rtl">
        
        {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center">
              <Sparkles className="text-white w-5 h-5" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight hidden sm:block">ארון וירטואלי</h1>
          </div>
          
          <nav className="flex gap-1 bg-gray-100 p-1 rounded-xl">
            {[
              { id: 'closet', icon: Shirt, label: 'הארון שלי' },
              { id: 'tryon', icon: User, label: 'מדידה' },
              { id: 'recommend', icon: Wand2, label: 'המלצות' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={cn(
                  "flex items-center gap-2 px-3 sm:px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                  activeTab === tab.id 
                    ? "bg-white text-black shadow-sm" 
                    : "text-gray-500 hover:text-black"
                )}
              >
                <tab.icon className="w-4 h-4" />
                <span className="hidden xs:inline">{tab.label}</span>
              </button>
            ))}
          </nav>

          <button 
            onClick={handleLogout}
            className="p-2 text-gray-400 hover:text-red-500 transition-colors"
            title="התנתקות"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <AnimatePresence mode="wait">
          {activeTab === 'closet' && (
            <motion.div
              key="closet"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold">הארון שלי</h2>
                  <p className="text-gray-500">נהלי את אוסף הבגדים שלך</p>
                </div>
                <div className="flex items-center gap-3">
                  <label className="bg-black text-white px-6 py-2.5 rounded-full font-medium flex items-center gap-2 cursor-pointer hover:bg-gray-800 transition-colors">
                    <Plus className="w-5 h-5" />
                    הוספת פריט
                    <input type="file" className="hidden" accept="image/*" onChange={(e) => handleFileSelect(e, 'clothing')} />
                  </label>
                </div>
              </div>

              <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide">
                <button
                  onClick={() => setFilterCategory('all')}
                  className={cn(
                    "px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all",
                    filterCategory === 'all' 
                      ? "bg-black text-white" 
                      : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                  )}
                >
                  הכל
                </button>
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat.id}
                    onClick={() => setFilterCategory(cat.id)}
                    className={cn(
                      "px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all",
                      filterCategory === cat.id 
                        ? "bg-black text-white" 
                        : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                    )}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              {clothes.length === 0 ? (
                <div className="bg-white rounded-3xl p-12 border border-gray-200 flex flex-col items-center justify-center text-center space-y-6">
                  <div className="w-24 h-24 bg-gray-50 rounded-full flex items-center justify-center">
                    <Shirt className="w-12 h-12 text-gray-300" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-xl font-bold">הארון שלך ריק</h3>
                    <p className="text-gray-500 max-w-sm">העלי תמונות של הבגדים שלך כדי להתחיל להרכיב לוקים ולמדוד אותם וירטואלית.</p>
                  </div>
                  <label className="bg-black text-white px-8 py-3 rounded-full font-medium cursor-pointer hover:bg-gray-800 transition-colors">
                    העלאת פריט ראשון
                    <input type="file" className="hidden" accept="image/*" onChange={(e) => handleFileSelect(e, 'clothing')} />
                  </label>
                </div>
              ) : (
                <div className="space-y-12">
                  {CATEGORIES
                    .filter(cat => filterCategory === 'all' || filterCategory === cat.id)
                    .map((cat) => {
                      const itemsInCategory = clothes.filter(c => c.category === cat.id);
                      if (itemsInCategory.length === 0) return null;
                      
                      return (
                        <div key={cat.id} className="space-y-6">
                          <div className="flex items-center gap-4">
                            <h3 className="text-xl font-bold flex items-center gap-2">
                              {cat.label}
                              <span className="text-sm font-normal text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                                {itemsInCategory.length}
                              </span>
                            </h3>
                            <div className="h-px flex-1 bg-gray-100"></div>
                          </div>
                          
                          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                            {itemsInCategory.map((item) => (
                              <motion.div
                                layout
                                key={item.id}
                                className="group bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-100 hover:shadow-md transition-all"
                              >
                                <div className="aspect-[3/4] relative">
                                  <img 
                                    src={item.imageUrl} 
                                    alt={item.name} 
                                    className="w-full h-full object-contain"
                                    referrerPolicy="no-referrer"
                                  />
                                  <button 
                                    onClick={() => deleteClothingItem(item)}
                                    className="absolute top-2 right-2 p-2 bg-white/80 backdrop-blur-sm rounded-full opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:bg-white"
                                    title="מחיקה"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                  <button 
                                    onClick={() => {
                                      setEditingItemId(item.id);
                                      setEditingName(item.name);
                                    }}
                                    className="absolute top-2 left-2 p-2 bg-white/80 backdrop-blur-sm rounded-full opacity-0 group-hover:opacity-100 transition-opacity text-blue-500 hover:bg-white"
                                    title="עריכת שם"
                                  >
                                    <Pencil className="w-4 h-4" />
                                  </button>
                                  <button 
                                    onClick={() => handleTryOn([item])}
                                    className="absolute bottom-2 right-2 p-2 bg-white/80 backdrop-blur-sm rounded-full opacity-0 group-hover:opacity-100 transition-opacity text-black hover:bg-white"
                                    title="מדידה וירטואלית"
                                  >
                                    <User className="w-4 h-4" />
                                  </button>
                                </div>
                                <div className="p-4">
                                  {editingItemId === item.id ? (
                                    <div className="flex items-center gap-2">
                                      <input
                                        autoFocus
                                        type="text"
                                        value={editingName}
                                        onChange={(e) => setEditingName(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') updateClothingItemName(item.id, editingName);
                                          if (e.key === 'Escape') setEditingItemId(null);
                                        }}
                                        className="w-full p-1 border-b-2 border-black focus:outline-none text-sm"
                                      />
                                      <button 
                                        onClick={() => updateClothingItemName(item.id, editingName)}
                                        className="text-green-500"
                                      >
                                        <Check className="w-4 h-4" />
                                      </button>
                                    </div>
                                  ) : (
                                    <h3 className="font-medium truncate">{item.name}</h3>
                                  )}
                                </div>
                              </motion.div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'tryon' && (
            <motion.div
              key="tryon"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="grid grid-cols-1 lg:grid-cols-3 gap-8"
            >
              <div className="lg:col-span-2 space-y-6">
                <div className="bg-white rounded-3xl p-8 border border-gray-200 aspect-[4/5] flex flex-col items-center justify-center relative overflow-hidden group">
                  {tryOnResult ? (
                    <div className="w-full h-full relative">
                      <div className="absolute top-4 right-4 z-10 bg-black/80 backdrop-blur-md text-white px-3 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase">
                        תוצאת המדידה
                      </div>
                      <img 
                        src={tryOnResult} 
                        alt="Try-on Result" 
                        className="w-full h-full object-contain rounded-2xl"
                        referrerPolicy="no-referrer"
                      />
                      <div className="absolute top-4 left-4 flex gap-2">
                        <button 
                          onClick={() => setTryOnResult(null)}
                          className="bg-white/80 backdrop-blur-sm px-4 py-2 rounded-full font-medium text-sm hover:bg-white shadow-sm"
                        >
                          חזרה לתמונה שלי
                        </button>
                        <a 
                          href={tryOnResult} 
                          download="try-on-result.png"
                          className="bg-black text-white px-4 py-2 rounded-full font-medium text-sm hover:bg-gray-800 shadow-sm"
                        >
                          הורדה
                        </a>
                      </div>
                    </div>
                  ) : userProfile?.photoUrl ? (
                    <div className="w-full h-full relative">
                      <div className="absolute top-4 right-4 z-10 bg-white/90 backdrop-blur-md text-black border border-gray-200 px-3 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase">
                        תמונת הבסיס שלך
                      </div>
                      <img 
                        src={userProfile.photoUrl} 
                        alt="Me" 
                        className="w-full h-full object-contain rounded-2xl"
                        referrerPolicy="no-referrer"
                      />
                      <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-white p-6 text-center">
                        <Camera className="w-10 h-10 mb-4" />
                        <p className="font-bold text-lg mb-2">רוצה להחליף תמונה?</p>
                        <div className="text-sm opacity-90 mb-6 space-y-1">
                          <p>העלי תמונה חדשה שעל גביה ה-AI ילביש את הבגדים</p>
                          <p className="font-bold text-yellow-400">הנחיות לתוצאה מושלמת:</p>
                          <p>1. שיראו את הרגליים בתמונה</p>
                          <p>2. להיות עם מכנס קצר צמוד וחולצה קצרה צמודה</p>
                        </div>
                        <label className="bg-white text-black px-8 py-3 rounded-full font-bold cursor-pointer hover:bg-gray-100 transition-colors shadow-lg">
                          החלפת תמונה
                          <input type="file" className="hidden" accept="image/*" onChange={(e) => handleFileSelect(e, 'profile')} />
                        </label>
                      </div>
                      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-md text-white px-4 py-2 rounded-full text-xs font-medium whitespace-nowrap">
                        ה-AI ילביש אותך על תמונה זו מבלי לשנות את המראה שלך
                      </div>
                    </div>
                  ) : (
                    <div className="text-center space-y-6">
                      <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto">
                        <Camera className="w-8 h-8 text-gray-400" />
                      </div>
                      <div className="space-y-4">
                        <h3 className="text-xl font-bold">העלי תמונה שלך למדידה</h3>
                        <div className="bg-gray-50 p-6 rounded-2xl border border-gray-100 space-y-3 text-right">
                          <p className="font-bold text-black mb-2">הנחיות לצילום (חשוב מאוד!):</p>
                          <div className="space-y-2 text-sm text-gray-600">
                            <p className="flex items-center gap-2">
                              <span className="w-5 h-5 bg-black text-white rounded-full flex items-center justify-center text-[10px]">1</span>
                              שיראו את הרגליים בתמונה (צילום גוף מלא)
                            </p>
                            <p className="flex items-center gap-2">
                              <span className="w-5 h-5 bg-black text-white rounded-full flex items-center justify-center text-[10px]">2</span>
                              להיות עם מכנס קצר צמוד וחולצה קצרה צמודה
                            </p>
                            <p className="flex items-center gap-2">
                              <span className="w-5 h-5 bg-black text-white rounded-full flex items-center justify-center text-[10px]">3</span>
                              עמדי במקום מואר היטב על רקע נקי
                            </p>
                          </div>
                        </div>
                      </div>
                      <label className="inline-block bg-black text-white px-10 py-4 rounded-full font-bold cursor-pointer hover:bg-gray-800 transition-all shadow-lg hover:scale-105 active:scale-95">
                        העלאת תמונה למדידה
                        <input type="file" className="hidden" accept="image/*" onChange={(e) => handleFileSelect(e, 'profile')} />
                      </label>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-6">
                <div className="bg-white rounded-3xl p-6 border border-gray-200">
                  <h3 className="text-lg font-bold mb-4">בניית אאוטפיט</h3>
                  <p className="text-xs text-gray-500 mb-4">בחרי פריט אחד מכל סוג כדי לראות איך הם משתלבים יחד.</p>
                  
                  <div className="space-y-6 max-h-[500px] overflow-y-auto p-1">
                    {CATEGORIES.map((cat) => {
                      const itemsInCategory = clothes.filter(c => c.category === cat.id);
                      if (itemsInCategory.length === 0) return null;
                      
                      return (
                        <div key={cat.id} className="space-y-2">
                          <h4 className="text-sm font-bold text-gray-400">{cat.label}</h4>
                          <div className="flex gap-2 overflow-x-auto pb-2">
                            {itemsInCategory.map((item) => (
                              <button 
                                key={item.id}
                                onClick={() => toggleSelectedItem(item)}
                                className={cn(
                                  "flex-shrink-0 w-20 h-20 rounded-xl border-2 overflow-hidden transition-all relative",
                                  selectedItems[cat.id]?.id === item.id ? "border-black scale-95 shadow-md" : "border-transparent hover:border-gray-200"
                                )}
                              >
                                <img src={item.imageUrl} alt={item.name} className="w-full h-full object-contain" referrerPolicy="no-referrer" />
                                {selectedItems[cat.id]?.id === item.id && (
                                  <div className="absolute inset-0 bg-black/10 flex items-center justify-center">
                                    <Check className="text-white w-5 h-5" />
                                  </div>
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                
                <div className="flex gap-3">
                  <button 
                    onClick={() => handleTryOn()}
                    disabled={!userProfile?.photoUrl || Object.values(selectedItems).every(v => v === null) || isProcessing}
                    className="flex-1 bg-black text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-800 transition-colors"
                  >
                    {isProcessing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
                    מדידה של כל האאוטפיט
                  </button>
                  <button 
                    onClick={() => setSelectedItems({
                      top: null,
                      bottom: null,
                      'full-body': null,
                      shoes: null,
                      accessory: null,
                      hoodie: null,
                    })}
                    className="bg-gray-100 text-gray-600 px-6 py-4 rounded-2xl font-bold hover:bg-gray-200 transition-colors"
                    title="נקה בחירה"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'recommend' && (
            <motion.div
              key="recommend"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-8"
            >
              <div className="text-center max-w-2xl mx-auto space-y-4">
                <h2 className="text-3xl font-bold">סטייליסט AI</h2>
                <p className="text-gray-500">תני ל-AI להרכיב לך את הלוק המושלם על סמך הארון שלך והאירוע.</p>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { id: 'holiday', icon: PartyPopper, label: 'חג', color: 'bg-orange-50 text-orange-600' },
                  { id: 'summer', icon: Sun, label: 'קיץ', color: 'bg-yellow-50 text-yellow-600' },
                  { id: 'winter', icon: CloudRain, label: 'חורף', color: 'bg-blue-50 text-blue-600' },
                  { id: 'school', icon: School, label: 'בית ספר', color: 'bg-green-50 text-green-600' },
                ].map((occasion) => (
                  <button
                    key={occasion.id}
                    onClick={() => {
                      setCustomOccasion('');
                      setSelectedOccasion(occasion.label);
                      handleGetRecommendation(occasion.label);
                    }}
                    className={cn(
                      "p-6 rounded-3xl border-2 transition-all text-right space-y-4",
                      selectedOccasion === occasion.label ? "border-black shadow-lg" : "border-transparent hover:border-gray-200",
                      occasion.color
                    )}
                  >
                    <occasion.icon className="w-8 h-8" />
                    <span className="block font-bold text-lg">{occasion.label}</span>
                  </button>
                ))}
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-2 text-gray-500 text-sm font-medium pr-2">
                  <Wand2 className="w-4 h-4" />
                  <span>או הקלידי אירוע משלך:</span>
                </div>
                <div className="flex flex-col md:flex-row gap-4 items-center bg-gray-50 p-4 rounded-3xl border border-gray-100">
                <div className="flex-1 w-full">
                  <input 
                    type="text" 
                    value={customOccasion} 
                    onChange={(e) => setCustomOccasion(e.target.value)}
                    placeholder="או הקלידי אירוע משלך (למשל: חתונה, אימון, דייט...)"
                    className="w-full p-4 rounded-2xl border-2 border-transparent focus:border-black focus:outline-none transition-all text-right"
                  />
                </div>
                <button 
                  onClick={() => {
                    if (customOccasion.trim()) {
                      setSelectedOccasion(customOccasion);
                      handleGetRecommendation(customOccasion);
                    }
                  }}
                  disabled={!customOccasion.trim() || isProcessing}
                  className="w-full md:w-auto px-8 py-4 bg-black text-white rounded-2xl font-bold hover:bg-gray-800 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isProcessing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
                  סטיילינג אישי
                </button>
              </div>
            </div>

              <div className="bg-white rounded-3xl p-8 border border-gray-200 min-h-[300px] space-y-6">
                {recommendation ? (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    {/* Left side: The Try-on Result */}
                    <div className="space-y-4">
                      <h4 className="font-bold text-lg">המדידה שלך:</h4>
                      <div className="aspect-[3/4] rounded-3xl overflow-hidden border border-gray-100 bg-gray-50 relative group">
                        {tryOnResult ? (
                          <img src={tryOnResult} alt="Try-on Result" className="w-full h-full object-contain" referrerPolicy="no-referrer" />
                        ) : isProcessing ? (
                          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/5 backdrop-blur-sm">
                            <Loader2 className="w-12 h-12 animate-spin text-black mb-4" />
                            <p className="font-medium">מכין את המדידה...</p>
                          </div>
                        ) : userProfile?.photoUrl ? (
                          <div className="relative h-full">
                            <img src={userProfile.photoUrl} alt="Your Photo" className="w-full h-full object-contain opacity-50" referrerPolicy="no-referrer" />
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-500 text-center p-4">
                              <Sparkles className="w-12 h-12 mb-4 opacity-20" />
                              <p className="font-medium">מוכנה למדידה!</p>
                              <p className="text-xs">לחצי על "רענון מדידה" כדי לראות את הלוק עלייך</p>
                            </div>
                          </div>
                        ) : (
                          <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 p-8 text-center">
                            <UserCircle className="w-12 h-12 mb-4 opacity-20" />
                            <p className="font-medium">חסרה תמונה שלך</p>
                            <p className="text-xs mt-2">העלי תמונה בלשונית "מדידה" כדי שנוכל להראות לך איך הבגדים נראים עלייך</p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Right side: Recommendation Details */}
                    <div className="space-y-6 flex flex-col">
                      <div className="markdown-body prose-sm flex-1">
                        <ReactMarkdown>{recommendation.description}</ReactMarkdown>
                      </div>
                      
                      {recommendation.items.length > 0 && (
                        <div className="space-y-4 pt-6 border-t border-gray-100">
                          <h4 className="font-bold">הפריטים המומלצים:</h4>
                          <div className="flex gap-4 overflow-x-auto pb-2">
                            {recommendation.items.map(item => (
                              <div key={item.id} className="flex-shrink-0 w-32 space-y-2">
                                <div className="aspect-square rounded-xl overflow-hidden border border-gray-100 relative group">
                                  <img src={item.imageUrl} alt={item.name} className="w-full h-full object-contain" referrerPolicy="no-referrer" />
                                  <button 
                                    onClick={() => handleTryOn([item], false)}
                                    className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-white"
                                  >
                                    <Sparkles className="w-6 h-6" />
                                  </button>
                                </div>
                                <p className="text-xs font-medium truncate">{item.name}</p>
                              </div>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-3">
                            <button 
                              onClick={() => handleTryOn(recommendation.items, false)}
                              className="bg-black text-white px-6 py-3 rounded-full font-bold flex items-center gap-2 hover:bg-gray-800 transition-colors text-sm"
                            >
                              <Sparkles className="w-4 h-4" />
                              רענון מדידה
                            </button>
                            <button 
                              onClick={() => {
                                const next = {
                                  top: null,
                                  bottom: null,
                                  'full-body': null,
                                  shoes: null,
                                  accessory: null,
                                  hoodie: null,
                                } as Record<ClothingCategory, ClothingItem | null>;
                                
                                recommendation.items.forEach(item => {
                                  if (item.category === 'full-body') {
                                    next.top = null;
                                    next.bottom = null;
                                    next.hoodie = null;
                                  }
                                  if (item.category === 'top' || item.category === 'bottom' || item.category === 'hoodie') {
                                    next['full-body'] = null;
                                  }
                                  next[item.category] = item;
                                });
                                
                                setSelectedItems(next);
                                setActiveTab('tryon');
                                toast.success('הלוק נטען לבונה האאוטפיטים!');
                              }}
                              className="bg-gray-100 text-gray-700 px-6 py-3 rounded-full font-bold flex items-center gap-2 hover:bg-gray-200 transition-colors text-sm"
                            >
                              <LayoutGrid className="w-4 h-4" />
                              עריכה בבונה האאוטפיטים
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center py-12">
                    <Sparkles className="w-12 h-12 text-gray-200 mb-4" />
                    <h3 className="text-xl font-bold text-gray-400">בחרי אירוע כדי להתחיל</h3>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Upload Modal */}
      <AnimatePresence>
        {isUploadModalOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-white rounded-3xl p-8 max-w-md w-full space-y-6"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold">הוספת פריט חדש</h3>
                <button onClick={() => setIsUploadModalOpen(false)} className="text-gray-400 hover:text-black">
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="aspect-[3/4] rounded-2xl overflow-hidden border border-gray-100">
                <img src={pendingImage!} alt="Pending" className="w-full h-full object-contain" referrerPolicy="no-referrer" />
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">שם הפריט</label>
                  <input 
                    type="text" 
                    value={pendingName}
                    onChange={(e) => setPendingName(e.target.value)}
                    className="w-full px-4 py-2 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-black"
                    placeholder="למשל: חולצה לבנה"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">קטגוריה</label>
                  <div className="grid grid-cols-2 gap-2">
                    {CATEGORIES.map((cat) => (
                      <button
                        key={cat.id}
                        onClick={() => setPendingCategory(cat.id)}
                        className={cn(
                          "px-4 py-2 rounded-xl border text-sm font-medium transition-all",
                          pendingCategory === cat.id ? "bg-black text-white border-black" : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
                        )}
                      >
                        {cat.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <button 
                onClick={saveClothingItem}
                disabled={!pendingName || isTagging}
                className="w-full bg-black text-white py-4 rounded-2xl font-bold hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isTagging ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    מנתח את הפריט...
                  </>
                ) : (
                  'שמירה לארון'
                )}
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {isProcessing && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-white p-6 rounded-2xl shadow-xl flex items-center gap-4">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span className="font-medium">ה-AI עושה קסמים...</span>
          </div>
        </div>
      )}
      <Toaster position="top-center" richColors />
      </div>
    </ErrorBoundary>
  );
}
