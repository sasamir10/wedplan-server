import type { Collection, Db } from 'mongodb';

interface AdminStats {
  totalRegisteredUsers: number;
  totalVendors: number;
  totalCustomers: number;
  totalServices: number;
  pendingServices: number;
  totalTransactions: number;
}

function usersCollection(database: Db): Collection {
  return database.collection('user');
}

function servicesCollection(database: Db): Collection {
  return database.collection('services');
}

function transactionsCollection(database: Db): Collection {
  return database.collection('transactions');
}

export async function getAdminStats(
  database: Db,
): Promise<AdminStats> {
  const [
    totalRegisteredUsers,
    totalVendors,
    totalCustomers,
    totalServices,
    pendingServices,
    totalTransactions,
  ] = await Promise.all([
    usersCollection(database).countDocuments(),
    usersCollection(database).countDocuments({ role: 'vendor' }),
    usersCollection(database).countDocuments({ role: 'customer' }),
    servicesCollection(database).countDocuments(),
    servicesCollection(database).countDocuments({ status: 'Pending' }),
    transactionsCollection(database).countDocuments(),
  ]);

  return {
    totalRegisteredUsers,
    totalVendors,
    totalCustomers,
    totalServices,
    pendingServices,
    totalTransactions,
  };
}
