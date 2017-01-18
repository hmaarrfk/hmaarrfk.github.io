---
title: Xilinx FPGAs

---

I'm documenting my process to programming a Xilinx FPGA I have my possession. I currently have the
[RedPitaya](http://redpitaya.com/) that I got for some analog applications I was originally
interested in. I plan on getting a [MicroZed](http://microzed.org/product/microzed) since it seems
to be more configurable and doesn't use so much (or any?) of the FPGA pins.

# OS and computer

I'm runing [Fedora 25](https://getfedora.org/) on a 64 bit Intel Laptop with 16 Gigs of RAM. There
seems to be a few bugs with Wayland so I'm still running Gnome Shell with X11.  I'm attempting to
install and run [Vivado WebPACK](https://www.xilinx.com/support/download.html) 2016.4.

## Installing Vivado
Download Vivado, then change the permissions of the downloaded file to allow
execusion, and install as root:
```sh
chmod +x Xilinx_Vivado_SDK_2016.4_1215_1_Lin64.bin
sudo ./Xilinx_Vivado_SDK_2016.4_1215_1_Lin64.bin
```

When prompted, I enable downloading and installing the SDK. I disabled anything
that didn't have to do with the Zynq chips. This made the download ~3.8GB in
size.

~~When prompted to save the link for a license somewhere you can find it. I
just saved it in `/`.~~ I think that the WebPACK license is free and doesn't
require anything. I'm not too sure, I'll have to wait until something
complains.

I got bored of starting Vivado from the command line, so I created some packages 
for nice desktop files for Fedora. Download the appropriate package by issuing the following
commands
```sh
sudo dnf copr enable hmaarrfk/useful_launchers
sudo dnf install vivado-2016.4-desktop.noarch
```

## Other software to download

### Minicom
Minicom is necessary for piece of mind when booting up your FPGA for the first time.  It will give
you access to the serial port output of the FPGA making it the easiest way to connect.

```sh
sudo dnf install minicom
```

#### Configure minicom
You need to add yourself to the `dialout` group to use the `/dev/ttyUSB0` that
appears when you try to interface the FPGA through the COM port. This makes
configuration very easy.

```sh
sudo usermod -a -G dialout YOUR_USER_NAME
```

For some reason, you have to reboot your computer if you are on Gnome Shell for
things to take effect. That shouldn't take too long if you have an SSD.

We can configure minicom without having the RedPitaya workign for the moment. Open `minicom` with:
```sh
sudo minicom -s
```
use `j` and `k` to navigate down and up respectively, `enter` to select.

Open `Modem and dialing`. Select entries with the appropriate letter on the keyboard. Type as usual, and `enter` to finish.
Clear entries `C` through `L`. You don't need these for connecting to a serial port.

Open `Serial port setup`. Change the Serial Device to `/dev/ttyUSBO`. If your Red Pitaya appears as a different device, then use that device. It will probably be just a higher number on the `/dev/ttyUSBX`.
Leave `Bps/Par/Bits` as is to `115200 8N1`. (115200 bits per second, 8 bit ber byte, No parity, 1 bit stop), but set Hardwave and Software Flow control to No.

You may choose to save as default (`dfl` or `Save setup as..` if you wish).

If you happened to exit minicom, you can now open minicom with your regular user
```sh
minicom
```

### FPGA software and development

This great repository by [Pavel Demin](https://github.com/pavel-demin) Exists
on [Github](https://github.com/pavel-demin/red-pitaya-notes). Clone it 

```sh
git clone git@github.com:pavel-demin/red-pitaya-notes.git
```

#### Install Fedora development packages

These tools seem to be necessary to develop Pavel Demin's code.  This isn't an exhaustive list
since I use my laptop for other development as well and I can't be sure what else I instaled. Let
me know what error messages you get and I'll be glad to help you debug things.

```sh
sudo dnf install dtc uboot-tools debootstrap qemu-user-static zerofree
```

Technically, I don't think you need `debootstrap`, `qemu-user-static`, or
`zerofree` if you are going to download Pavel's prebuilt image. I just like to
install things from scratch when I can to learn as much as I can.

#### Enable binfmt
I'm not really sure how I got this one working. I'll try to follow these instructions again on a
new computer when I have the time.  You need to enable `binfmt` to create the SD card. `binfmt` is
crucial for executing `arm` programs on your intel computer. I think the idea in doing so is that
an `arm` emulator on your computer is faster than an actual `arm` processor. While that may be
true, Pavel's scripts run directly from the SD card, which I think might make things slower
than they should be. In either case, we will simply follow his lead.

You can check the status of binfmt with
```sh
sudo systemctl status systemd-binfmt.service
```
Start it with
```sh
sudo systemctl start systemd-binfmt.service
```
I think the following command should enable it to start on default when your computer boots:
```sh
sudo systemctl enable systemd-binfmt.service
```
This should finally allow you to run the scrits that create the SD image from scratch.

## Turning on your Red Pitaya
You are now ready to boot up your Red Pitaya. Safely remove your SD card if you haven't already,
plug it in the Red Pitaya, connect a USB cable between your computer and the COM port on the Red
Pitaya, and connect a 2A power supply to the PWR port.

Let the Red Pitaya Boot. It should spew near nonesess on your computer. If somebody can figure out
how to let `minicom` interpret UTF-8, I would be very happy to know. In either case, you shouldn't
need to use `minicom` too much after setting up your FPGA. It is a very slow communication method,
only 115200 bits per second, or 14kbps, back to the dialup era.

You'll now have access to a log in prompt, asking you for a username (`root`) and a password
(`changeme`).

# Getting on the Internet
Orignally, the RedPitaya requires you to have a wired connection, on a dedicated ethernet port
between your computer and the FPGA. You probably don't have that luxury on a laptop. 
In either case, I'll walk you through both setting up a wired bridge between your laptop's Wifi
access and the RedPitaya and connecting your RedPitaya directly to your home wifi network.

# Wired configuration
Follow  the instructions
[here](https://major.io/2015/03/29/share-a-wireless-connection-via-ethernet-in-gnome-3-14/) to
bridge your home wifi to a wired connectors for your Red Pitaya.
You will want to edit the file `/etc/network/interfaces.d/eth0` to contain the following
```sh
allow-hotplug eth0
iface eth0 inet dhcp
```
(it might also need a line `auto eth0`, but I'm not too sure at this point). I think it is easier
for your to pop in the SD card on your computer and edit the file with your favorite editor.  Once
you have configured the bridge, you should restart the Red Pitaya so that it takes to the new
configuration.

# Wifi for the RedPitaya
You might want to invest in a [USB wireless
adapter](https://www.amazon.com/gp/product/B014HTNO52/ref=oh_aui_detailpage_o01_s01?ie=UTF8&psc=1)
I got bored of all the cabling, and for a simple testing rig, I decided it was probably easiest to
get a wifi card working for the RedPitaya. Of course, easier said than done right ;).

I worked with [Pavel Demin](https://github.com/pavel-demin/red-pitaya-notes/issues/449) on GitHub
to help understand how to get it all working. It turns out that the drivers aren't yet available
for [Debian Jessie](https://www.debian.org/releases/stable/) and that you had to copy it manually
from newer kernel versions. The details are in the
[issue](https://github.com/pavel-demin/red-pitaya-notes/issues/449) linked above.
Make sure `/etc/network/interfaces.d/wlan0` contains:
```sh
allow-hotplug wlan0
auto wlan0
iface wlan0 inet dhcp
  wpa-ssid YOURNETWORK_SSID
  wpa-psk WPAPSKHASH
```
You can encrypt your wpa-psk passphrase by
[adapting](https://wiki.debian.org/WiFi/HowToUse#WPA-PSK_and_WPA2-PSK)
```
wpa_passphrase myssid my_very_secret_passphrase
```
Boot up your RedPitaya and voilà. Let me know if you have any questions. Happy coding.

My next post will be focused on deciphering what Pavel Demin is doing with all his scripts.
It seems no matter how much you try to simplify  things, you can never truely simplify `hello world!`.
