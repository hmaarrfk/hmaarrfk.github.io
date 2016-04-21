---
title: Raspberry Pi!

---

I just received a Raspberry Pi 3 Model B in the mail today! This little piece of hardware is pretty nifty.

![My RaspberryPi3]({{ base.url }}/assets/20160420-raspberrypi3.jpg)

I bought it from [Adafruit](https://www.adafruit.com/) with one of their [cases](https://www.adafruit.com/products/2258) and a little [Spy Camera](https://www.adafruit.com/products/1937). I got the case because my apartment has carpet and I wanted to minimize the risk of electromagnetic discharge when handling this small computer.

As always, I find myself struggling when I need to get new pieces of hardware up and running. I felt like it is worthwhile to share my experience with others so that they know what to expect and what they can do to get their own up and running.

## My setup
I use Fedora on all my personal computers. At the time of writing, I'm using Fedora 23. To get the RapberryPi working, I wasn't able to use the NOOBS 1.9 operating system picker. I'm really not sure why. Instead I downloaded the Raspbian OS directly and used the `dd` command to get it onto my SD card.

## First steps
You always expect to do a little bit of system configuration to get started. First thing is first:

  1. Expand your SD card storage
  2. Remove unnecessary packages
  3. Update the packages in your system
  4. Enable the camera
  5. Enable the ssh-server


I remove packages first because it potentially reduces the download and update time for packages you will remove anyway!

### Raspbian configuration
The RPi comes with a nifty configuration utility. It has an interface in the terminal of the RaspberryPi, and doesn't require knowledge of the command line. Simply open up a terminal, and run the command

```
sudo raspi-config
```

It is pretty cool. We will be using it quite a bit.

### Expanding the SD Card storage
Within `raspi-config`, select the `1 Expand Filesystem` option and reboot. Voila! You can check that you have successfully increased your storage with the command
```
df -h
```
and noticing the line with `/dev/root`. The option `-h` allows you to read the storage in human units.

### Remove unnecessary packages
The RPi seems to have a few unecessary packages, I'm looking at you Wolfram Mathematica. Wolfram Mathematica alone takes up 700 MB on your SD card. I also removed LibreOffice since I don't need word processing on an underpowered computer.
To remove everything all at once, run the following command:

```
sudo apt-get remove wolfram-engine scratch penguinspuzzle python-pygame dillo netsurf-gtk libreoffice* 
sudo apt-get remove minecraft-pi sonic-pi bluej greenfoot nodered claws-mail
```

I like to remove `idle-python2.7`. Unless you have a good reason, you should switch to python 3 at this point.

```
sudo apt-get remvoe idle-python2.7
```

If you don't want java

```
sudo apt-get remvoe oracle-java8-jdk
```

Now you can run

```
sudo apt-get autoremove
```
to remove all the unnecessary packages that were left behind.

Here are a few posts that inspired me [this](https://glenngeenen.be/strip-down-raspbian/).

### Update the packages in your system
Now you can run 
```
sudo aptitude upgrade
```
to upgrade your system.

After this, I was left with a system about 1.9 GB in size. I checked this with the command `df -h`.

### Enable the camera
I'll be using the camera for a few projects. You need to enable it manually. We will use the `raspi-config` interface for this.
Select the option that enables the camera, and reboot your system.

Here is the reference to the RPi [documentation](https://www.raspberrypi.org/documentation/usage/camera/python/README.md).

### Enabling ssh
Within the `raspi-config`, you should enable sshd. This is particularly useful. I do recommend changing the password with the command `passwd` first. The default password is `raspberry`.

Full disclaimer, ssh seems to have an issue over WiFi with me. It seems to have been documented 
[here](https://www.raspberrypi.org/forums/viewtopic.php?f=28&t=138631&start=25).

## Install your useful software
I like `vim` and `iceweasle` (Firefox)! What will be the first software that you install?

## WiFi woes
The RaspberryPi3 is rather new and bugs are to be expected. I guess we are back to how linux was in 2007 when having a working WiFi connection was the [Holy Grail!!!](https://www.raspberrypi.org/forums/viewtopic.php?f=28&t=138631&start=25) In either case, I setup a [bridge](https://major.io/2015/03/29/share-a-wireless-connection-via-ethernet-in-gnome-3-14/) between my laptop's WiFi and an old ethernet cable I had lying around. This allowed me to finally use `ssh` and `git`!
