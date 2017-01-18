---
title: Making your own website

---

Making a website to showcase your work has become commonplace for many individuals trying to share their ideas with the world.
Unfortunately, paying for a hosting service can be an expensive endeavour if you are not profiting from your website.

In this post, I will list the tools that I have used to create this website as well as a few other ones.

# Requirements

When considering different website platforms, I had a few requirements that helped me find the 
ideal technology:

  1. **Ease of content enditing:** After my website is setup, I shouldn't have to worry about HTML tags on a daily basis. I should be able to add and remove mostly text based content rather easilyA
  2. **Ease of extracting content:** I should be able to create backups of my content easily. I tried websites based on MySQL.
  3. **Ease of hosting:** No server side scripting! This means I can host on any computer that serves webpages.
  4. **Page templating:** Pages should have templates that automatically update if I choose to change the design of my webpages. I don't want to have to copy and paste menus around my website.

# Jekyll

[Jekyll](https://jekyllrb.com/) is this great static website generator built on Ruby by the [Github](https://github.com/) team.
It allows you to convert [Markdown](https://en.wikipedia.org/wiki/Markdown) into HTML to create a nice website.
It basically hits points that revolve around content editaing and extraction as well as page templating.
Markdown was originally a language used to format readme files and plain text emails that would people to specify titles to make these last two more readible. Sounds perfect for a simple website to me!

To make the website look a little better than black text on a white background, I used a theme from [Bootswatch](http://bootswatch.com/).

# Hosting

Hosting remains a problem. You can actually choose to host Jekyll based websites on [Github Pages](https://pages.github.com/). Unfortunately, you can't use HTTPS with Github Pages so I decided to host this website on [Gitlab](https://pages.gitlab.io/). You can find the source for this website [here](https://gitlab.com/markharfouche/markharfouche.gitlab.io).

## Static website hosting on your university servers

I also manage two other website, my [group website](http://www.its.caltech.edu/~aphyariv/) at Caltech, and the website of the [Caltech OSA Student Chapter](http://osa.caltech.edu/). They look pretty similar to this one because I basically used the same theme for all 3 websites.
These websites are hosting on the Caltech Linux servers. I chose this so that future students could easily have access to the website without requiring some weird forgotten password.

To push the websites, I chose to do this via a Deploy Hook through git. The advantage of doing this, is you don't have to worry about copy pasting the files yourself after you commit your website to your version tracking software. It will do it for you automatically. In fact, Gitlab does something very similar when you commit your website to their servers.

I added the following hook for the OSA website I'm hosting:

```sh
#!/bin/sh

GIT_REPO=git@git.markharfouche.com:osawebsite
TMP_GIT_CLONE=`mktemp -d osawebsite_git_tmp_XXXX --tmpdir=/tmp`
PUBLIC_HOST=osa@ssh.caltech.edu
PUBLIC_DIR=public_html/


git clone ${GIT_REPO} ${TMP_GIT_CLONE}
# Change into the newly created repo
pushd ${TMP_GIT_CLONE}

# install bundler
gem install bundler
# update it
gem update bundler

# Install the necessary dependencies for our website
bundle install

# Build the website, enable future posts too
bundle exec jekyll build --future

# rsync
# delete after makes sure that the files are not deleted as they come in but all once after the transfer is complete
# delete-excluded deletes any files that no longer exist in the new directory
# Must specify crappy protocol
rsync -arv --protocol=30 --delete-after --delete-excluded --perms _site/ ${PUBLIC_HOST}:${PUBLIC_DIR}

pushd ${TMP_GIT_CLONE}

# Return to the normal directory
popd

# remove the temp dir
rm -rf ${TMP_GIT_CLONE}
```

Feel free to use this if it helps you!


