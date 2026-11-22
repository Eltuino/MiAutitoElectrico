import { Ban, Briefcase, Coins, Home as HomeIcon, Radio, Star, Zap } from 'lucide-react';
import type { RoutePref } from '../lib/routeChoice';
import type { SavedKind } from '../store/saved';

export const ROUTE_ICON: Record<RoutePref, React.ReactNode> = {
  rapida: <Zap size={17} />,
  economica: <Coins size={17} />,
  sintag: <Radio size={17} />,
  sinpeajes: <Ban size={17} />,
};

export const SAVED_ICON: Record<SavedKind, React.ReactNode> = {
  casa: <HomeIcon size={18} />,
  trabajo: <Briefcase size={18} />,
  otro: <Star size={18} />,
};
