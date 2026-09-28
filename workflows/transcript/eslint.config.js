import { base } from '@ai-pipeline/eslint-config/base';
import { handlers } from '@ai-pipeline/eslint-config/handlers';

export default [...base(import.meta.dirname), ...handlers()];
