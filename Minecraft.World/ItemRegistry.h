#pragma once

#include <unordered_map>
#include <string>
#include <mutex>
#include <functional>

class Item;

class ItemRegistry {
public:
	static void Register(int id, const std::string& name, Item* item);

	static void UnregisterById(int id);
	static void UnregisterByName(const std::string& name);

	static Item* GetById(int id);
	static Item* GetByName(const std::string& name);
	static bool HasId(int id);
	static bool HasName(const std::string& name);

	static void Clear();

	static void ForEach(const std::function<void(int, Item*)>& cb);

	static size_t Size();

	static void PopulateFromGlobalItemArray();

private:
	ItemRegistry() = delete;
	ItemRegistry(const ItemRegistry&) = delete;
	ItemRegistry& operator=(const ItemRegistry&) = delete;

	// internal storage
	static std::unordered_map<int, Item*> s_items;
	static std::unordered_map<std::string, Item*> s_itemsByName;
	static std::mutex s_mutex;
};