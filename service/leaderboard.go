package service

import (
	"sort"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func ImageGenerationRanking(limit int) ([]model.LeaderboardItem, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	logs, err := readAICallLogs()
	if err != nil {
		return nil, err
	}
	type aggregate struct {
		UserID      string
		Username    string
		DisplayName string
		AvatarURL   string
		Count       int
	}
	byUser := map[string]*aggregate{}
	for _, item := range logs {
		if !isSuccessfulImageAICall(item) {
			continue
		}
		key := strings.TrimSpace(item.UserID)
		if key == "" {
			key = strings.TrimSpace(item.UserDisplayName)
		}
		if key == "" {
			key = "anonymous"
		}
		current := byUser[key]
		if current == nil {
			current = &aggregate{UserID: strings.TrimSpace(item.UserID), DisplayName: strings.TrimSpace(item.UserDisplayName)}
			byUser[key] = current
		}
		current.Count++
	}
	items := make([]model.LeaderboardItem, 0, len(byUser))
	for _, item := range byUser {
		if item.UserID != "" {
			if user, ok, err := repository.GetUserByID(item.UserID); err == nil && ok {
				item.Username = user.Username
				item.DisplayName = firstNonEmpty(user.DisplayName, item.DisplayName)
				item.AvatarURL = user.AvatarURL
			}
		}
		items = append(items, model.LeaderboardItem{
			UserID:      item.UserID,
			Username:    item.Username,
			DisplayName: item.DisplayName,
			AvatarURL:   item.AvatarURL,
			Count:       item.Count,
		})
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Count != items[j].Count {
			return items[i].Count > items[j].Count
		}
		return firstNonEmpty(items[i].DisplayName, items[i].Username, items[i].UserID) < firstNonEmpty(items[j].DisplayName, items[j].Username, items[j].UserID)
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func isSuccessfulImageAICall(item model.AICallLog) bool {
	if item.Status < 200 || item.Status >= 300 {
		return false
	}
	endpoint := strings.TrimSpace(item.Endpoint)
	if strings.HasPrefix(endpoint, "/images/") || endpoint == "/sub2-image-tasks" {
		return true
	}
	return endpoint == "/responses" && strings.Contains(item.RequestBody, "image_generation")
}
