#include "stdafx.h"
#include "ItemRegistry.h"

#include "net.minecraft.locale.h"
#include "net.minecraft.world.item.h"

#include <algorithm>

std::unordered_map<int, Item*> ItemRegistry::s_items;
std::unordered_map<std::string, Item*> ItemRegistry::s_itemsByName;
std::mutex ItemRegistry::s_mutex;

void ItemRegistry::Register(int id, const std::string& name, Item* item) {
	std::lock_guard<std::mutex> lk(s_mutex);
	s_items[id] = item;
	if (!name.empty()) {
		s_itemsByName[name] = item;
	}
}

void ItemRegistry::UnregisterById(int id) {
	std::lock_guard<std::mutex> lk(s_mutex);
	auto it = s_items.find(id);
	if (it != s_items.end()) {
		// try remove from name map if present (value equality)
		Item* val = it->second;
		for (auto iter = s_itemsByName.begin(); iter != s_itemsByName.end(); ) {
			if (iter->second == val) iter = s_itemsByName.erase(iter);
			else ++iter;
		}
		s_items.erase(it);
	}
}

void ItemRegistry::UnregisterByName(const std::string& name) {
	std::lock_guard<std::mutex> lk(s_mutex);
	auto it = s_itemsByName.find(name);
	if (it != s_itemsByName.end()) {
		Item* val = it->second;
		// remove id entries matching the same pointer
		for (auto iter = s_items.begin(); iter != s_items.end(); ) {
			if (iter->second == val) iter = s_items.erase(iter);
			else ++iter;
		}
		s_itemsByName.erase(it);
	}
}

Item* ItemRegistry::GetById(int id) {
	std::lock_guard<std::mutex> lk(s_mutex);
	auto it = s_items.find(id);
	return (it != s_items.end()) ? it->second : nullptr;
}

Item* ItemRegistry::GetByName(const std::string& name) {
	std::lock_guard<std::mutex> lk(s_mutex);
	auto it = s_itemsByName.find(name);
	return (it != s_itemsByName.end()) ? it->second : nullptr;
}

bool ItemRegistry::HasId(int id) {
	std::lock_guard<std::mutex> lk(s_mutex);
	return s_items.find(id) != s_items.end();
}

bool ItemRegistry::HasName(const std::string& name) {
	std::lock_guard<std::mutex> lk(s_mutex);
	return s_itemsByName.find(name) != s_itemsByName.end();
}

void ItemRegistry::Clear() {
	std::lock_guard<std::mutex> lk(s_mutex);
	s_items.clear();
	s_itemsByName.clear();
}

void ItemRegistry::ForEach(const std::function<void(int, Item*)>& cb) {
	std::lock_guard<std::mutex> lk(s_mutex);
	for (auto& p : s_items) {
		cb(p.first, p.second);
	}
}

size_t ItemRegistry::Size() {
	std::lock_guard<std::mutex> lk(s_mutex);
	return s_items.size();
}

// Populate from Item::items (global static array). This assumes Item::getName() returns wstring.
// Uses a simple narrow conversion (assumes ASCII names). Replace conversion with a proper UTF-8 conversion if needed.
void ItemRegistry::PopulateFromGlobalItemArray() {
	// Item and Item::items declared in net.minecraft.world.item.h
	using namespace std;


	std::lock_guard<std::mutex> lk(s_mutex);
	Clear();

	for (unsigned int i = 0; i < Item::items.length; ++i) {
		Item* it = Item::items[i];
		if (!it) continue;
		// id is public const int id;
		int id = it->id;
		std::wstring wname = it->getName();
		std::string name;
		name.assign(wname.begin(), wname.end());
		s_items[id] = it;
		if (!name.empty()) s_itemsByName[name] = it;
	}
}