---
title: Faking your eth0

---

Getting a unique identifier on a computer is tricky business. Desktops are
built to be modular and over their lifetime many components might change.

Many companies rely on identifying one's computer for
licensing software. My attention was brought to this issue when I tried to get
my hands on a copy of a free [Xilinx's
Vivado](http://www.xilinx.com/products/design-tools/vivado.html) software.
They have a license manager that uses your mac address to identify your
computer.  The problem is that they use the mac address of the device listed as
`eth0`. This is problematic if one of the two scenarios applies:

  * You don't have a wired network card. This might be common if you have a newer laptop.
  * You use a recent Linux distribution like [Fedora](fedoraproject.org) that moved away from naming their network
cards starting with `eth0`.

In these cases, you don't have a network device called `eth0` and their license
manager will refuse to recognize your computer. To solve this problem, many have
suggested forcing your kernel to assign network card names the "old way" by
changing a boot parameter but that only works if you actually have a network card. For the record, I tried many of these fixes, and they simply did not
work for me.  Instead, I suggest creating a fake network card, called `eth0` and
giving yourself your choice of MAC address.


I assume all commands are being run as root. You can switch to root with the command

```sh
sudo -i
```

Edit (or create) the file called `/etc/rc.d/rc.local` so that it contains

```sh
#!/bin/sh

/sbin/ip tuntap add dev eth0 mode tap
/sbin/ifconfig eth0 up
/sbin/ip link set dev eth0 address de:ad:be:ef:ca:fe
```

Make sure `rc.local` file is executable with:
```
chmod 755 /etc/rc.d/rc.local
```

The 3 commands do the following:

  1. Create a new (fake) network device called `eth0` in tap mode. (I have no idea what tap mode is.)
  2. Turn that (fake) device on.
  3. Assign the mac address `de:ad:be:ef:ca:fe` to the `eth0` device. Feel free to change this to whatever you want, as long as it isn't the same one of your existing network cards.

Test the commands out by running them individually before rebooting.
You can check if you have a new network interface by running the command `ifconfig`.

I remember that the command `/sbin/ip tuntap` will complain that you are
missing a file in the default Fedora installation. You simply have to create it with the `touch` command

```
touch MISSING_FILENAME
```
That should fix things. Unfortunately, I configured my computer such a long time ago, I don't remember the exact missing file.

You should now be able to reboot your computer and have what looks like a valid `eth0` card.

Done!
