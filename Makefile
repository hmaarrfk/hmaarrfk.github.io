all: server


server:
	bundle exec jekyll server --future

gem:
	bundle install
	bundle update

.PHONY: all server gem

