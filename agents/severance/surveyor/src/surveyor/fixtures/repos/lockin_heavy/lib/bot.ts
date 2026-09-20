import { checkBotId } from 'botid';
import { firewall } from '@vercel/firewall';
export async function protect() {
  return checkBotId() && firewall;
}
