export type ClothingCategory = 'top' | 'bottom' | 'shoes' | 'accessory' | 'full-body' | 'hoodie';

export interface ClothingItem {
  id: string;
  uid: string;
  imageUrl: string;
  category: ClothingCategory;
  name: string;
  tags?: string[];
  createdAt?: any;
}

export interface UserProfile {
  uid: string;
  photoUrl: string;
  displayName?: string;
  email?: string;
}

export interface OutfitRecommendation {
  id: string;
  occasion: string;
  description: string;
  items: ClothingItem[];
}
