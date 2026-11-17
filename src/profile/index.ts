/**
 * 用户画像 - 主导出
 */

export type {
  ProfileSource,
  ProfileItem,
  UserProfile,
  ProfileConfig,
} from './types';

export { DEFAULT_PROFILE_CONFIG } from './types';

export {
  generateUserProfile,
  pruneExpiredInferences,
} from './generator';

export {
  generateProfileInjection,
  generateDetailedProfile,
  generateBriefProfile,
} from './inject';
