import { listPlate, listUnconfirmedFor, listWaitingOn } from "../domain/repo";
import type { HomeData } from "./view";

export async function loadHomeData(db: D1Database, userId: string): Promise<HomeData> {
  const [plate, waiting, unconfirmed] = await Promise.all([
    listPlate(db, userId),
    listWaitingOn(db, userId),
    listUnconfirmedFor(db, userId),
  ]);
  return { plate, waiting, unconfirmed };
}
