import { GoogleGenAI, Type } from "@google/genai";
import { ClothingItem, OutfitRecommendation, ClothingCategory } from "../types";

const getApiKey = (): string => {
  // Priority 1: gem_api (User secret) - This is the key the user explicitly asked to use
  if (typeof process !== 'undefined' && process.env && process.env.gem_api) {
    return process.env.gem_api;
  }
  
  const metaEnv = (import.meta as any).env;
  if (metaEnv && metaEnv.VITE_GEM_API) {
    return metaEnv.VITE_GEM_API;
  }

  // Priority 2: API_KEY (Standard secret name)
  if (typeof process !== 'undefined' && process.env && process.env.API_KEY) {
    return process.env.API_KEY;
  }
  
  if (metaEnv && metaEnv.VITE_API_KEY) {
    return metaEnv.VITE_API_KEY;
  }

  // Fallback to built-in ONLY if user-provided is missing
  // The user said "don't rely on built in gemini api key", so we put it last
  if (typeof process !== 'undefined' && process.env && process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY;
  }
  
  if (metaEnv && metaEnv.VITE_GEMINI_API_KEY) {
    return metaEnv.VITE_GEMINI_API_KEY;
  }

  // Priority 4: window.aistudio (Preview environment)
  const aistudio = (window as any).aistudio;
  if (aistudio && typeof aistudio.getApiKey === 'function') {
    const key = aistudio.getApiKey();
    if (key) return key;
  }

  return "";
};

const SYSTEM_INSTRUCTION = `אתה סטייליסט אישי מומחה בעל טעם משובח באופנה. 
התפקיד שלך הוא לעזור למשתמשות לבנות סטים של בגדים (Outfits) מהארון הפרטי שלהן, תוך התחשבות באירוע, במזג האוויר ובטרנדים העדכניים ביותר.
אתה תמיד עונה בעברית רהוטה, חיובית ומעצימה.

דגש חשוב: כאשר אתה מבצע מדידה וירטואלית (Virtual Try-On), עליך לשמור על זהות המשתמשת בצורה אבסולוטית. אסור לשנות את הפנים, השיער, מבנה הגוף או כל פרט מזהה אחר. המטרה היא להראות למשתמשת איך הבגדים נראים עליה, לא על דוגמנית אחרת.`;

export async function getOutfitRecommendation(clothes: ClothingItem[], occasion: string): Promise<OutfitRecommendation> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("מפתח API חסר. אנא וודאי שהגדרת את gem_api בסודות או בחרת מפתח בממשק.");
  }

  const ai = new GoogleGenAI({ apiKey });
  if (clothes.length === 0) {
    throw new Error("הארון ריק");
  }

  const clothesList = clothes.map(c => `- ID: ${c.id}, Name: ${c.name}, Category: ${c.category}, Tags: ${(c.tags || []).join(', ')}`).join('\n');

  const prompt = `
אירוע: ${occasion}

רשימת הבגדים בארון:
${clothesList}

אנא בנה סט לבוש מושלם עבור האירוע הזה מתוך הרשימה לעיל. 
הנחיות חשובות:
1. בחר פריטים שמתאימים זה לזה מבחינת צבעים וסגנון.
2. אם האירוע הוא "חג" (Holiday), חובה: כל פריטי הלבוש (חולצה, מכנסיים/חצאית/שמלה) חייבים להיות בצבע לבן (WHITE) בלבד.
3. אם האירוע הוא "קיץ" (Summer), בחר פריטים קלילים.
4. אם האירוע הוא "חורף" (Winter), בחר פריטים חמים (קפוצ׳ונים, חולצות ארוכות).
5. חוקי קטגוריות:
   - אם בחרת "גוף מלא" (full-body), אל תבחר "חלק עליון" (top) או "חלק תחתון" (bottom) או "קפוצ׳ון" (hoodie).
   - אם בחרת "קפוצ׳ון" (hoodie), אל תבחר "חלק עליון" (top).
   - תמיד נסה לכלול נעליים (shoes) אם קיימות בארון.
   - אביזרים (accessory) הם אופציונליים אך מוסיפים המון.

החזר תשובה בפורמט JSON בלבד:
{
  "recommendedItemIds": ["id1", "id2", ...],
  "description": "הסבר מפורט בעברית על הבחירה, למה הפריטים מתאימים וטיפים לסטיילינג משלים."
}
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            recommendedItemIds: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            description: { type: Type.STRING }
          },
          required: ["recommendedItemIds", "description"]
        }
      }
    });

    const text = response.text || '{}';
    try {
      const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const result = JSON.parse(cleanJson);
      const recommendedItems = clothes.filter(c => result.recommendedItemIds?.includes(c.id));
      
      return {
        id: Math.random().toString(),
        occasion,
        items: recommendedItems,
        description: result.description || "הנה המלצה לסטיילינג עבורך."
      };
    } catch (parseError) {
      console.error("JSON Parse Error:", parseError, "Original text:", text);
      throw new Error("נכשלנו בעיבוד המלצת הלבוש. אנא נסי שוב.");
    }
  } catch (error: any) {
    console.error("Recommendation Error:", error);
    if (error.message?.includes("SAFETY")) {
      throw new Error("ההמלצה נחסמה מטעמי בטיחות. נסי לתאר את האירוע בצורה אחרת.");
    }
    throw error;
  }
}

export async function tagClothingItem(base64Image: string, name: string, category: ClothingCategory): Promise<string[]> {
  const apiKey = getApiKey();
  if (!apiKey) return [];

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `נתח את פריט הלבוש בתמונה. 
השם שניתן לו: ${name}
הקטגוריה: ${category}

החזר רשימה של עד 5 תגיות (Tags) בעברית המתארות את הפריט (צבע, בד, סגנון, עונה).`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        { text: prompt },
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: base64Image.includes(',') ? base64Image.split(',')[1] : base64Image
          }
        }
      ],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            tags: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          },
          required: ["tags"]
        }
      }
    });

    const text = response.text || '{"tags":[]}';
    try {
      const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const result = JSON.parse(cleanJson);
      return result.tags || [];
    } catch (parseError) {
      console.error("Tagging JSON Parse Error:", parseError, "Original text:", text);
      return [];
    }
  } catch (error) {
    console.error("Tagging Error:", error);
    return [];
  }
}

export async function virtualTryOn(userPhotoBase64: string, clothingItems: ClothingItem[]): Promise<string> {
  if (!userPhotoBase64) {
    throw new Error("אנא העלי תמונה שלך קודם בלשונית 'מדידה'");
  }
  
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("מפתח API חסר. אנא וודאי שהגדרת את gem_api בסודות או בחרת מפתח בממשק.");
  }

  const getMimeType = (base64: string) => {
    const match = base64.match(/^data:([^;]+);base64,/);
    return match ? match[1] : "image/jpeg";
  };

  const getData = (base64: string) => {
    if (!base64) return "";
    const parts = base64.split(',');
    return parts.length > 1 ? parts[1] : parts[0];
  };

  const userData = getData(userPhotoBase64);
  if (!userData) {
    throw new Error("תמונת המשתמש אינה תקינה. אנא נסי להעלות אותה שוב.");
  }

  const userPart = {
    inlineData: {
      mimeType: getMimeType(userPhotoBase64),
      data: userData,
    },
  };
  
  const categories = clothingItems.map(item => item.category);
  const hasTop = categories.includes('top') || categories.includes('hoodie');
  const hasBottom = categories.includes('bottom');
  const hasFullBody = categories.includes('full-body');
  const hasShoes = categories.includes('shoes');
  
  const prompt = `Perform a high-quality virtual try-on.
  
  CRITICAL: ABSOLUTE IDENTITY PRESERVATION IS MANDATORY.
  
  STRICT IDENTITY PRESERVATION RULES:
  1. BASE PERSON: Use the "Identity Reference Person" as the ONLY base. You are FORBIDDEN from generating a new person or using a generic model.
  2. FACE & IDENTITY: You MUST keep the EXACT same face from the reference image. Do not modify facial features, eyes, nose, mouth, expression, or makeup. The person MUST be a 100% identical clone.
  3. HAIR & SKIN: Keep the EXACT same hair (style, color, texture, length) and skin tone.
  4. BODY & POSE: Keep the EXACT same body shape, height, proportions, and pose.
  5. BACKGROUND: Keep the EXACT same background and lighting.
  
  CLOTHING REPLACEMENT RULES:
  - You are provided with ${clothingItems.length} clothing item(s).
  ${hasFullBody ? '- REPLACE the entire current outfit with the provided "Full Body" item.' : ''}
  ${hasTop ? '- REPLACE the current top/shirt with the provided "Top" item.' : '- KEEP the person\'s ORIGINAL top/shirt from the reference image.'}
  ${hasBottom ? '- REPLACE the current bottom/pants/skirt with the provided "Bottom" item.' : '- KEEP the person\'s ORIGINAL bottom/pants/skirt from the reference image.'}
  ${hasShoes ? '- REPLACE the current shoes with the provided "Shoes" item. SHOW FULL BODY.' : '- KEEP the person\'s ORIGINAL shoes/feet.'}
  
  CLOTHING FIT:
  1. Overlay the new clothes onto the BASE PERSON.
  2. The clothes MUST adapt to the person's body; the person MUST NOT adapt to the clothes.
  3. Ensure the new clothes fit naturally and realistically on the person's body.
  4. Maintain the texture, color, and details of the clothing items provided.
  
  Output ONLY the final photorealistic image of the SAME person wearing the NEW clothes.`;

  const modelsToTry = [
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
    "gemini-2.5-flash-image"
  ];
  let lastError: any = null;

  for (const modelName of modelsToTry) {
    try {
      console.log(`מנסה מדידה וירטואלית עם מודל: ${modelName}`);
      
      // Check for API key selection if using paid models (3.x series)
      if (modelName.includes("gemini-3")) {
        const aistudio = (window as any).aistudio;
        if (aistudio && typeof aistudio.hasSelectedApiKey === 'function') {
          const hasKey = await aistudio.hasSelectedApiKey();
          if (!hasKey && typeof aistudio.openSelectKey === 'function') {
            await aistudio.openSelectKey();
          }
        }
      }

      const currentApiKey = getApiKey();
      if (!currentApiKey) {
        throw new Error("מפתח API חסר. אנא וודאי שהגדרת את gem_api בסודות או בחרת מפתח בממשק.");
      }

      const ai = new GoogleGenAI({ apiKey: currentApiKey });
      const config: any = {};
      
      const hasShoes = clothingItems.some(item => item.category === 'shoes');
      const preferredAspectRatio = hasShoes ? "3:4" : "1:1";

      // Configure image generation parameters based on model capabilities
      if (modelName.includes("image-preview")) {
        // gemini-3-pro-image-preview and gemini-3.1-flash-image-preview support imageSize
        config.imageConfig = {
          aspectRatio: preferredAspectRatio,
          imageSize: "1K"
        };
      } else {
        // gemini-2.5-flash-image and others
        config.imageConfig = {
          aspectRatio: preferredAspectRatio
        };
      }

      const isNanoBanana = modelName.includes("2.5") || (modelName.includes("flash") && !modelName.includes("3.1"));
      
      const contents: any = {
        parts: [
          { text: "Identity Reference Person (DO NOT CHANGE FACE, BODY OR IDENTITY):" },
          userPart,
          { text: "Clothing Items to Wear (PUT THESE ON THE PERSON ABOVE):" },
          ...clothingItems.map((item, index) => {
            const itemData = getData(item.imageUrl);
            if (!itemData) return [];
            return [
              { text: `CLOTHING ITEM ${index + 1} (${item.category.toUpperCase()}):` },
              {
                inlineData: {
                  mimeType: getMimeType(item.imageUrl),
                  data: itemData,
                },
              }
            ];
          }).flat(),
          { text: prompt }
        ]
      };

      const generationConfig: any = { ...config };
      
      // For image models, we use a specific English system instruction to ensure identity preservation
      const IMAGE_SYSTEM_INSTRUCTION = `You are a virtual try-on specialist. 
Your absolute priority is to preserve the identity of the person in the "Identity Reference Person" image. 
This person is your ONLY BASE. You must NOT change their face, hair, body, or background. 
Your only task is to overlay the provided clothing items onto this specific person. 
Even if multiple items are provided, the person's identity must remain 100% identical to the reference image.
THE CLOTHES MUST BE ADAPTED TO THE PERSON, NEVER THE PERSON TO THE CLOTHES.`;

      if (!isNanoBanana) {
        generationConfig.systemInstruction = IMAGE_SYSTEM_INSTRUCTION;
      } else {
        contents.parts[0].text = IMAGE_SYSTEM_INSTRUCTION + "\n\n" + contents.parts[0].text;
      }

      // Use a more robust contents structure
      const response = await ai.models.generateContent({
        model: modelName,
        contents,
        config: generationConfig
      });

      const candidate = response.candidates?.[0];
      
      if (candidate?.finishReason === 'SAFETY') {
        throw new Error("התמונה נחסמה על ידי מסנני בטיחות. נסי להשתמש בתמונות ברורות וצנועות יותר.");
      }

      if (!candidate?.content?.parts) {
        throw new Error(`המודל ${modelName} לא החזיר תוכן תקין.`);
      }

      let foundImage = false;
      let textContent = "";

      for (const part of candidate.content.parts) {
        if (part.inlineData) {
          console.log(`המדידה הצליחה עם מודל: ${modelName}`);
          return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
        }
        if (part.text) {
          textContent += part.text + " ";
        }
      }
      
      if (textContent) {
        console.warn(`המודל ${modelName} החזיר טקסט במקום תמונה: ${textContent}`);
        // If it's a safety block or refusal in text
        if (textContent.includes("safety") || textContent.includes("unable") || textContent.includes("cannot")) {
          throw new Error(`המודל סירב ליצור את התמונה: ${textContent}`);
        }
      }
      
      throw new Error(`לא נמצאה תמונה בתוצאה של מודל ${modelName}.`);

    } catch (error: any) {
      const isLastModel = modelName === modelsToTry[modelsToTry.length - 1];
      if (isLastModel) {
        console.error(`שגיאה סופית במדידה עם מודל ${modelName}:`, error);
      } else {
        console.warn(`מודל ${modelName} נכשל, מנסה מודל חלופי...`, error.message || error);
      }
      lastError = error;
      
      if (error.message?.includes("SAFETY") || error.message?.includes("בטיחות")) {
        throw error;
      }
      
      if (error.message?.includes("API key not valid") || error.message?.includes("401")) {
        throw new Error("מפתח ה-API אינו תקין. אנא בדקי את ההגדרות.");
      }

      if (error.message?.includes("PERMISSION_DENIED") || error.message?.includes("403")) {
        lastError = new Error("אין הרשאה למודל זה. ייתכן שנדרש מפתח API עם חיוב (Billing) פעיל. אנא וודאי שבחרת מפתח תקין.");
        // Trigger key selection again on 403
        const aistudio = (window as any).aistudio;
        if (aistudio && typeof aistudio.openSelectKey === 'function') {
          aistudio.openSelectKey();
        }
      }
      
      // Continue to next model
      continue;
    }
  }

  if (lastError) {
    if (lastError.message?.includes("Requested entity was not found")) {
      throw new Error("המודל לא נמצא או שאין לך גישה אליו. אנא וודאי שבחרת מפתח API תקין.");
    }
    throw lastError;
  }

  throw new Error("לא התקבלה תמונה מהמודל.");
}
